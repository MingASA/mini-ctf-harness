import importlib.util
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'offline_harness/scripts/managed_server.py'
spec = importlib.util.spec_from_file_location('managed', SCRIPT)
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)


class ManagedLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.launchers = []
        self.owners = []
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]

    def tearDown(self):
        # Only clean up exact process identities created by this test.
        owner = self.root / 'owner.json'
        if owner.exists():
            self.owners.append(json.loads(owner.read_text()))
        for record in self.owners:
            live = managed.identity(record['pid'])
            if live and all(live[k] == record[k] for k in ('exe', 'start_ticks')):
                try:
                    os.killpg(record['pid'], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for launcher in self.launchers:
            if launcher.poll() is None:
                launcher.terminate()
            launcher.wait(timeout=5)
        self.temp.cleanup()

    def config(self, name, *, key=None, loading=False, stubborn=False, fail=False):
        code = ("import signal\nfrom http.server import BaseHTTPRequestHandler,HTTPServer\n"
                + ("signal.signal(signal.SIGTERM,signal.SIG_IGN)\n" if stubborn else '')
                + "class H(BaseHTTPRequestHandler):\n"
                + " def log_message(self,*args): pass\n"
                + " def do_GET(self): self.send_response(200); self.end_headers(); "
                + f"self.wfile.write(b'{{\"status\":\"{'loading' if loading else 'ok'}\"}}')\n"
                + f"HTTPServer(('127.0.0.1',{self.port}),H).serve_forever()")
        value = {'root': str(self.root), 'requestId': name, 'key': key or name, 'model': key or name,
                 'exe': '/bin/false' if fail else sys.executable,
                 'args': [] if fail else ['-c', code], 'baseUrl': f'http://127.0.0.1:{self.port}'}
        file = self.root / f'selection-{name}.json'
        managed.atomic(file, value)
        managed.atomic(self.root / 'selection.json', value)
        return file

    def run_script(self, *args, check=True):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              check=check, capture_output=True, text=True, timeout=25)

    def loading(self, name):
        file = self.config(name, loading=True)
        launcher = subprocess.Popen([sys.executable, str(SCRIPT), str(file)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.launchers.append(launcher)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if (self.root / 'owner.json').exists():
                record = self.owner()
                if record['requestId'] == name:
                    return file, launcher, record
            time.sleep(.02)
        self.fail('Loading process never published ownership')

    def owner(self):
        record = json.loads((self.root / 'owner.json').read_text())
        self.owners.append(record)
        return record

    def assert_stopped(self, record):
        live = managed.identity(record['pid'])
        self.assertTrue(not live or live['state'] == 'Z' or live['start_ticks'] != record['start_ticks'])

    def test_actual_linux_owner_reuse_replacement_and_stop(self):
        first_config = self.config('one')
        self.run_script(first_config)
        first = self.owner()
        self.run_script(self.config('retry', key='one'))
        reused = self.owner()
        self.assertEqual(reused['pid'], first['pid'])
        self.assertEqual(reused['requestId'], first['requestId'])
        self.assertEqual(reused['selectionId'], 'retry')
        self.run_script(self.config('two'))
        second = self.owner()
        self.assertNotEqual(first['pid'], second['pid'])
        self.assertEqual(second['key'], 'two')
        self.assert_stopped(first)
        self.run_script('--stop', self.root)
        self.assert_stopped(second)
        self.assertFalse((self.root / 'owner.json').exists())
        self.run_script('--stop', self.root)

    def test_close_during_loading_and_delayed_launcher_cannot_restart(self):
        file, launcher, record = self.loading('loading')
        self.run_script('--stop', self.root)
        self.assert_stopped(record)
        self.assertEqual(launcher.wait(timeout=5), 0)
        self.run_script(file)
        self.assertFalse((self.root / 'owner.json').exists())
        self.assertFalse((self.root / 'launch-failed.json').exists())

    def test_replace_loading_model_and_ignore_superseded_launcher(self):
        old_file, launcher, first = self.loading('old')
        self.run_script(self.config('new'))
        current = self.owner()
        self.assertEqual(current['key'], 'new')
        self.assert_stopped(first)
        self.assertEqual(launcher.wait(timeout=5), 0)
        self.run_script(old_file)
        self.assertEqual(self.owner()['pid'], current['pid'])
        self.assertFalse((self.root / 'launch-failed.json').exists())

    def test_switch_recovers_a_model_ignoring_sigterm(self):
        self.run_script(self.config('stuck', stubborn=True))
        first = self.owner()
        self.run_script(self.config('replacement'))
        self.assert_stopped(first)
        self.assertEqual(self.owner()['key'], 'replacement')

    def test_identity_mismatch_is_never_signalled(self):
        self.run_script(self.config('one'))
        record = self.owner()
        managed.atomic(self.root / 'owner.json', {**record, 'start_ticks': record['start_ticks'] + 1})
        result = self.run_script('--stop', self.root, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity changed', result.stderr)
        self.assertEqual(managed.identity(record['pid'])['start_ticks'], record['start_ticks'])

    def test_identity_is_rechecked_before_force_kill(self):
        record = {'pid': 123, 'start_ticks': 456, 'exe': '/fixture', 'state': 'S'}
        changed = {**record, 'start_ticks': 789}
        with patch.object(managed, 'identity', side_effect=[record, record, changed]), \
             patch.object(managed.os, 'getpgid', return_value=123), \
             patch.object(managed.os, 'killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                managed.stop_owned(record, grace_seconds=0)
            kill.assert_called_once_with(123, signal.SIGTERM)

    def test_old_waiter_cannot_overwrite_replacement_failure(self):
        _, launcher, _ = self.loading('old')
        result = self.run_script(self.config('broken', fail=True), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(launcher.wait(timeout=5), 0)
        failure = json.loads((self.root / 'launch-failed.json').read_text())
        self.assertEqual(failure['requestId'], 'broken')


if __name__ == '__main__':
    unittest.main()
