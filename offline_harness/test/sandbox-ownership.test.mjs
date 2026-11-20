import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('interactive and offline solvers repair sealed task roots before running as their owner', () => {
  const script = String.raw`
import importlib.util, pathlib, tempfile
from unittest.mock import patch

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

interactive = load('interactive', 'scripts/interactive_environment.py')
offline = load('offline', 'scripts/provision_sandbox.py')
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp); base = root/'offline-harness'/'work'; work = base/'fixture'
    work.mkdir(parents=True)
    work.chmod(0o555)
    config = {'runtime': {'root': str(root/'runtime'), 'docker': 'docker', 'solverImage': 'image'},
              'provision': {'workBase': str(base)}, 'uid': 1234, 'gid': 4321,
              'environments': {'offline': {'type': 'offline'}}}
    events = []
    def docker(self, *args, **kwargs):
        events.append(('docker', args)); return 'a'*64 if args[0] == 'create' else ''
    with patch.object(interactive, 'call', return_value='ext4'), \
         patch.object(interactive.Environment, 'docker', docker), \
         patch.object(interactive.os, 'chown', side_effect=lambda *a: events.append(('chown', a))):
        interactive.Environment(config).provision('fixture', str(work), 'offline', '')
    assert events[0] == ('chown', (work, 1234, 4321)), events
    assert (work.stat().st_mode & 0o777) == 0o700
    args = next(value for kind, value in events if kind == 'docker' and value[0] == 'create')
    assert args[args.index('--user') + 1] == '1234:4321'
    assert '--read-only' in args and args[args.index('--cap-drop') + 1] == 'ALL'
    assert args[args.index('--memory') + 1] == '2048m'

    class Result:
        stdout = ''
    def run(args, **kwargs):
        events.append(('offline', args))
        result = Result(); result.stdout = '[{"Id":"sha256:image"}]' if args[1:3] == ['image','inspect'] else 'b'*64
        return result
    work.chmod(0o555)
    with patch.object(offline.subprocess, 'run', side_effect=run), \
         patch.object(offline.os, 'getuid', return_value=1234), patch.object(offline.os, 'getgid', return_value=4321), \
         patch.object(offline.os, 'chown', side_effect=lambda *a: events.append(('offline-chown', a))):
        offline.provision('docker', 'unix:///tmp/docker.sock', 'image', str(base), str(work))
    assert ('offline-chown', (work, 1234, 4321)) in events
    assert (work.stat().st_mode & 0o777) == 0o700
    args = next(value for kind, value in events if kind == 'offline' and value[1:3] == ['run','-d'])
    assert args[args.index('--user') + 1] == '1234:4321'
    assert '--read-only' in args and args[args.index('--cap-drop') + 1] == 'ALL'
`;
  const result = spawnSync('python3', ['-c', script], {cwd: new URL('..', import.meta.url), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
