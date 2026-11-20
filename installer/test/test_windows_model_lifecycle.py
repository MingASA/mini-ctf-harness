"""Opt-in WSL tests: real Windows child processes, mocked GPU/readiness probes."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace

POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'offline_harness/scripts/Terminal-Model.ps1'


@unittest.skipUnless(os.environ.get('HARNESS_TEST_WINDOWS_LIFECYCLE') == '1',
                     'Set HARNESS_TEST_WINDOWS_LIFECYCLE=1 in WSL to run Windows process tests')
class WindowsModelLifecycle(unittest.TestCase):
    def ps(self, *args, check=True):
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', *args],
                                capture_output=True, text=True, errors='replace', timeout=40, cwd='/mnt/c')
        if check:
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result

    def win(self, file):
        return subprocess.check_output(['wslpath', '-w', str(file)], text=True).strip()

    def setUp(self):
        windows_temp = self.ps('-Command', '[IO.Path]::GetTempPath()').stdout.strip()
        local_temp = subprocess.check_output(['wslpath', '-u', windows_temp], text=True).strip()
        self.temp = tempfile.TemporaryDirectory(prefix='harness-model-test-', dir=local_temp)
        self.root = pathlib.Path(self.temp.name)
        self.exe = self.ps('-Command', '(Get-Process -Id $PID).Path').stdout.strip()
        self.launchers = []
        self.owners = []
        script = self.root / 'Terminal-Model.ps1'
        shutil.copyfile(SOURCE, script)
        self.wrapper = self.root / 'wrapper.ps1'
        script_path = self.win(script).replace("'", "''")
        self.wrapper.write_text("""param([string]$Config,[switch]$Stop,[string]$RuntimeRoot,[string]$ExpectedExe,[string]$ResultFile)
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$global:FixtureRoot=$PSScriptRoot
function Get-CimInstance($ClassName){
 if($ClassName -eq 'Win32_OperatingSystem'){throw 'Fixed RAM admission checks must not gate model loading'}
}
function Get-NetTCPConnection {}
function nvidia-smi.exe {throw 'GPU resource query unavailable'}
function Invoke-RestMethod {
 if(Test-Path -LiteralPath (Join-Path $global:FixtureRoot 'ready')){return @{status='ok'}}
 return @{status='loading'}
}
$call=@{};foreach($key in $PSBoundParameters.Keys){if($key -ne 'ResultFile'){$call[$key]=$PSBoundParameters[$key]}}
$result=@{exit=0;error=''}
try{& '""" + script_path + """' @call}catch{$result.exit=1;$result.error=$_.Exception.Message}
finally{[IO.File]::WriteAllText($ResultFile,($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
""", encoding='utf-8')

    def tearDown(self):
        file = self.root / 'owner.json'
        if file.exists():
            self.owners.append(json.loads(file.read_text(encoding='utf-8-sig')))
        for owner in self.owners:
            exe = self.exe.replace("'", "''")
            stamp = owner['start_time'].replace("'", "''")
            self.ps('-Command', f"$p=Get-Process -Id {owner['pid']} -ErrorAction SilentlyContinue; "
                    f"if($p -and $p.Path -eq '{exe}' -and $p.StartTime.ToUniversalTime().ToString('o') -eq '{stamp}')"
                    "{Stop-Process -InputObject $p}", check=False)
        for process in self.launchers:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
        self.temp.cleanup()

    def config(self, name, *, key=None):
        value = {'requestId': name, 'key': key or name, 'model': key or name, 'root': self.win(self.root),
                 'exe': self.exe, 'args': ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'],
                 'baseUrl': 'http://127.0.0.1:1', 'contextTokens': 8192}
        file = self.root / f'selection-{name}.json'
        file.write_text(json.dumps(value))
        (self.root / 'selection.json').write_text(json.dumps(value))
        return file

    def start(self, file, wait=True):
        args = ['-File', self.win(self.wrapper), '-Config', self.win(file)]
        return self.run_wrapper(args, wait=wait)

    def run_wrapper(self, args, *, wait=True, check=True):
        # WSL's relay can outlive PowerShell while its model child is resident.
        # Observe a durable completion receipt rather than waiting for relay EOF.
        result_file = self.root / ('result-' + uuid.uuid4().hex + '.json')
        process = subprocess.Popen([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', *args,
                                    '-ResultFile', self.win(result_file)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd='/mnt/c')
        self.launchers.append(process)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if wait and result_file.exists():
                value = json.loads(result_file.read_text(encoding='utf-8-sig'))
                if check:
                    self.assertEqual(value['exit'], 0, value['error'])
                return SimpleNamespace(returncode=value['exit'], stderr=value['error'])
            if not wait and (self.root / 'owner.json').exists():
                self.owner()
                return process
            time.sleep(.05)
        failure = self.root / 'launch-failed.json'
        self.fail('Windows launcher did not publish ownership: ' +
                  (failure.read_text(encoding='utf-8-sig') if failure.exists() else str(process.poll())))

    def owner(self):
        record = json.loads((self.root / 'owner.json').read_text(encoding='utf-8-sig'))
        self.owners.append(record)
        return record

    def stop(self, check=True):
        return self.run_wrapper(['-File', self.win(self.wrapper), '-Stop', '-RuntimeRoot', self.win(self.root),
                                 '-ExpectedExe', self.exe], check=check)

    def test_switch_from_legacy_receipt_with_null_executable(self):
        (self.root / 'ready').touch()
        self.start(self.config('one'))
        first = self.owner()
        (self.root / 'owner.json').write_text(json.dumps({**first, 'exe': None}))
        self.start(self.config('two'))
        second = self.owner()
        self.assertNotEqual(first['pid'], second['pid'])
        self.assertEqual(second['exe'].lower(), self.exe.lower())
        self.assertEqual(second['key'], 'two')
        self.start(self.config('retry', key='two'))
        reused = self.owner()
        self.assertEqual(reused['pid'], second['pid'])
        self.assertEqual(reused['requestId'], second['requestId'])
        self.assertEqual(reused['selectionId'], 'retry')
        self.stop()
        self.assertFalse((self.root / 'owner.json').exists())

    def test_replace_during_loading_and_reject_delayed_old_launch(self):
        old = self.config('old')
        launcher = self.start(old, wait=False)
        (self.root / 'ready').touch()
        self.start(self.config('new'))
        current = self.owner()
        self.assertEqual(current['key'], 'new')
        self.assertEqual(launcher.wait(timeout=5), 0)
        self.start(old)
        self.assertEqual(self.owner()['pid'], current['pid'])
        self.assertFalse((self.root / 'launch-failed.json').exists())

    def test_close_during_loading_and_prevent_delayed_restart(self):
        old = self.config('old')
        launcher = self.start(old, wait=False)
        self.stop()
        self.assertEqual(launcher.wait(timeout=5), 0)
        self.start(old)
        self.assertFalse((self.root / 'owner.json').exists())

    def test_changed_identity_is_not_stopped(self):
        (self.root / 'ready').touch()
        self.start(self.config('one'))
        owner = self.owner()
        (self.root / 'owner.json').write_text(json.dumps({**owner, 'start_time': 'wrong'}))
        result = self.stop(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('identity changed', result.stderr)
        self.ps('-Command', f"Get-Process -Id {owner['pid']} -ErrorAction Stop")


if __name__ == '__main__':
    unittest.main()
