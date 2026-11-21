#!/usr/bin/env python3
"""Exercise a *dedicated*, idle patched llama-server, including MTP if enabled.

This test generates on slot 0 and erases slot 1. Never point it at a live
competition server. Start a separate server with model alias ``btw-test``.
"""
import argparse
import json
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--origin', required=True, help='dedicated loopback test server, not the competition service')
args = parser.parse_args()
url = urlparse(args.origin)
if url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1') or url.path not in ('', '/') or url.query or url.fragment:
    raise SystemExit('The test server must be an explicit loopback HTTP origin')
if url.port in (None, 8080):
    raise SystemExit('Use a separate test port, not the default competition port')
base = args.origin.rstrip('/')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(route, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + route, data=data, headers={'Content-Type': 'application/json'})
    with opener.open(req, timeout=180) as response:
        return response.read()

def snapshot():
    return json.loads(request('/kv-cache'))

models = json.loads(request('/v1/models'))
if [m['id'] for m in models.get('data', [])] != ['btw-test']:
    raise SystemExit('The dedicated test server must serve only alias btw-test')
initial = snapshot()
if not initial.get('ctf_btw', {}).get('enabled') or any(s['is_processing'] or s['retains_kv'] for s in initial['slots']):
    raise SystemExit('Start an idle, empty server with the protected /btw backend')

system = 'You are examining a forensic investigation. ' + 'Consider the evidence carefully and explain the facts. ' * 45
common = [{'role': 'system', 'content': system},
          {'role': 'user', 'content': 'The evidence is a service log with error code 503. Summarize the important facts.'}]
outputs, errors = {}, {}
def generate(slot, question, max_tokens):
    body = {'model': 'btw-test', 'messages': common + [{'role': 'user', 'content': question}],
            'id_slot': slot, 'stream': True, 'cache_prompt': True, 'max_tokens': max_tokens,
            'temperature': 0, 'chat_template_kwargs': {'enable_thinking': False}}
    try:
        outputs[slot] = request('/v1/chat/completions', body).decode()
    except Exception as error:
        errors[slot] = str(error)

main = threading.Thread(target=generate, args=(0, 'Write the integers from 1 to 500 in order.', 384))
main.start()
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    if snapshot()['slots'][0]['state'] == 'generating':
        break
    if not main.is_alive():
        raise RuntimeError(f'Main generation ended before the branch started: {errors}')
    time.sleep(.02)
else:
    raise RuntimeError('Main generation did not start')

branch = threading.Thread(target=generate, args=(1, 'List the evidence that might be missing in detail.', 128))
branch.start()
observations = []
while main.is_alive() or branch.is_alive():
    if time.monotonic() >= deadline:
        raise RuntimeError('Timed out waiting for the two test requests')
    state = snapshot()
    observations.append((state['scheduler']['generating'],
                         state['contexts']['target']['pools'][0]['shared_cells'],
                         (state['contexts'].get('draft') or {}).get('pools', [{}])[0].get('shared_cells', 0)))
    time.sleep(.02)
main.join(); branch.join()
if errors or set(outputs) != {0, 1} or any('[DONE]' not in output for output in outputs.values()):
    raise RuntimeError(f'Incomplete responses: {errors}')
if not any(generating == 2 for generating, _, _ in observations):
    raise RuntimeError('The test did not observe both slots generating')
if max(target for _, target, _ in observations) == 0:
    raise RuntimeError('No shared target cells observed')
if initial['contexts'].get('draft') and max(draft for _, _, draft in observations) == 0:
    raise RuntimeError('No shared MTP cells observed')

before = snapshot()
erased = json.loads(request('/slots/1?action=erase', {}))
after = snapshot()
if erased.get('id_slot') != 1:
    raise RuntimeError('Backend did not confirm branch release')
for name in ('target', 'draft'):
    if before['contexts'].get(name) is None:
        continue
    def occupied(state, seq):
        return sum(next((item['occupied_cells'] for item in pool['sequences'] if item['id'] == seq), 0)
                   for pool in state['contexts'][name]['pools'] if pool['kind'].startswith('attention'))
    if occupied(before, 0) != occupied(after, 0) or occupied(after, 1) != 0:
        raise RuntimeError(f'{name} sequence ownership changed incorrectly')
print('PASS: concurrent generation, shared target/MTP cells, and branch-only release')
