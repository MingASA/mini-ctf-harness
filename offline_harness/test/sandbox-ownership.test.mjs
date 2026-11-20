import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validateSandbox} from '../src/broker.mjs';

test('interactive helper preserves Docker errors instead of hiding them behind a traceback',()=>{
 const script=String.raw`
import contextlib, io, json, pathlib, runpy, subprocess, sys, tempfile
from unittest.mock import patch
with tempfile.TemporaryDirectory() as tmp:
    file=pathlib.Path(tmp)/'config.json'
    file.write_text(json.dumps({'runtime':{'root':tmp,'docker':'docker'}}))
    sys.argv=['interactive_environment.py','prepare','--config',str(file)]
    output=io.StringIO()
    with patch('os.geteuid',return_value=0), contextlib.redirect_stderr(output), \
         patch('subprocess.run',side_effect=subprocess.CalledProcessError(125,['docker'],stderr='Docker resource option rejected')):
        try:runpy.run_path('scripts/interactive_environment.py',run_name='__main__')
        except SystemExit as error:assert error.code==125,error
        else:raise AssertionError('Expected helper failure')
    assert output.getvalue().strip()=='Docker resource option rejected',output.getvalue()
`;
 const result=spawnSync('python3',['-c',script],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});

test('interactive and offline solvers repair sealed task roots before running as their owner', () => {
  const script = String.raw`
import importlib.util, pathlib, tempfile, json
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

    containers = []
    for memory, cpus, pids, tmp_mib in [(6144, 6, 128, 128), (16384, 12.5, 4096, 2048), (64, 0.25, 8, 8), (0, 0, -1, 1024)]:
        events.clear()
        config['solver'] = {'memoryMiB': memory, 'cpus': cpus, 'pids': pids, 'tmpMiB': tmp_mib}
        with patch.object(interactive, 'call', return_value='ext4'), \
             patch.object(interactive.Environment, 'docker', docker), \
             patch.object(interactive.os, 'chown'):
            interactive.Environment(config).provision('fixture', str(work), 'offline', '')
        args = next(value for kind, value in events if kind == 'docker' and value[0] == 'create')
        assert args[args.index('--memory') + 1] == str(memory)+'m'
        assert args[args.index('--memory-swap') + 1] == str(memory)+'m'
        assert args[args.index('--cpus') + 1] == str(cpus)
        assert args[args.index('--pids-limit') + 1] == str(pids)
        assert args[args.index('--tmpfs') + 1] == '/tmp:rw,nosuid,nodev,size='+str(tmp_mib)+'m'
        assert '--memory-reservation' not in args and '--cpuset-cpus' not in args
        containers.append({'Id':'fixture','Image':'image','State':{'Running':True},
            'HostConfig':{'NetworkMode':'none','CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],
                          'Memory':int(args[args.index('--memory')+1][:-1])*1024*1024,
                          'PidsLimit':int(args[args.index('--pids-limit')+1]),'ReadonlyRootfs':True},
            'Mounts':[{'Destination':'/work','Source':'/fixture/work','Type':'bind'}]})
    print(json.dumps(containers))

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
        offline.provision('docker', 'unix:///tmp/docker.sock', 'image', str(base), str(work),
                          memory_mib=16384, cpus=12.5, pids=4096, tmp_mib=2048)
    assert ('offline-chown', (work, 1234, 4321)) in events
    assert (work.stat().st_mode & 0o777) == 0o700
    args = next(value for kind, value in events if kind == 'offline' and value[1:3] == ['run','-d'])
    assert args[args.index('--user') + 1] == '1234:4321'
    assert '--read-only' in args and args[args.index('--cap-drop') + 1] == 'ALL'
    assert args[args.index('--memory') + 1] == '16384m'
    assert args[args.index('--memory-swap') + 1] == '16384m'
    assert args[args.index('--cpus') + 1] == '12.5'
    assert args[args.index('--pids-limit') + 1] == '4096'
    assert args[args.index('--tmpfs') + 1] == '/tmp:rw,nosuid,nodev,size=2048m'
`;
  const result = spawnSync('python3', ['-c', script], {cwd: new URL('..', import.meta.url), encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for(const container of JSON.parse(result.stdout))assert.equal(validateSandbox(container,[],{containerId:'fixture',imageId:'image',workDir:'/fixture/work'}),true);
});
