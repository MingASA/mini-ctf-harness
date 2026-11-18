#!/usr/bin/env python3
"""Fast-forward the harness and apply only the installation changes that are needed."""
import argparse,json,os,pathlib,shutil,subprocess,sys

ROOT=pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'installer'))
from bootstrap import MANIFEST,configured_models,fetch_asset,privileged,run,write_json

def output(args):
    return subprocess.check_output(list(map(str,args)),cwd=ROOT,text=True).strip()

def changed_actions(paths):
    paths=set(paths)
    return {
        'dependencies':any(path in ('offline_harness/package.json','offline_harness/package-lock.json') for path in paths),
        'solver_image':any(path.startswith('docker/') for path in paths),
        'model_profiles':any(path in ('installer/assets.json','installer/bootstrap.py','installer/update.py') for path in paths),
    }

def configured_path(profiles,profile_id,key,asset_id,data):
    value=profiles.get(profile_id,{}).get(key)
    if value and pathlib.Path(value).is_file():return pathlib.Path(value).resolve()
    return fetch_asset(MANIFEST['assets'][asset_id],data/'models')

def sync_model_profiles(data,config):
    existing=config.get('models',[])
    profiles={profile.get('id') or profile.get('model'):profile for profile in existing}
    model=configured_path(profiles,'qwen3.8-27b-iq4xs','modelPath','qwen3.8-27b-iq4xs',data)
    projector=configured_path(profiles,'qwen3.8-27b-iq4xs-vision','mmprojPath','qwen3.8-27b-projector',data)
    qwen35=configured_path(profiles,'qwen3.5-9b-ctf-web-q8','modelPath','qwen3.5-9b-ctf-web-q8',data)
    qwen35_projector=configured_path(profiles,'qwen3.5-9b-ctf-web-q8-vision','mmprojPath','qwen3.5-9b-projector',data)
    config['models']=configured_models(model,projector,qwen35,qwen35_projector,existing)

def node_dependencies(state,env):
    node=pathlib.Path(state['node']);npm=node.with_name('npm')
    if not npm.exists():
        found=shutil.which('npm',path=str(node.parent)+':'+env.get('PATH',''))
        if not found:raise RuntimeError('Installed npm executable is missing')
        npm=pathlib.Path(found)
    run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=ROOT/'offline_harness',env=env)

def rebuild_solver(config,config_file,env):
    helper=ROOT/'offline_harness/scripts/interactive_environment.py'
    privileged(['python3',helper,'daemon','--config',config_file],env=env)
    runtime=config['runtime'];docker=runtime['docker']
    docker_env=dict(env,DOCKER_HOST=runtime.get('dockerHost','unix://'+str(pathlib.Path(runtime['root'])/'run/docker.sock')),DOCKER_CONFIG=str(pathlib.Path(runtime['root'])/'docker-config'))
    run([docker,'build','--network=host','--pull','--tag','mini-ctf-tools:1',ROOT/'docker'],env=docker_env)
    config['runtime']['solverImage']=json.loads(subprocess.check_output([docker,'image','inspect','mini-ctf-tools:1'],env=docker_env,text=True))[0]['Id']

def apply(old_head):
    state_file=ROOT/'.install.json'
    if not state_file.exists():raise RuntimeError('Run ./mini-ctf install before updating')
    state=json.loads(state_file.read_text());data=pathlib.Path(state['data_dir']).resolve();config_file=pathlib.Path(state['config']).resolve()
    config=json.loads(config_file.read_text());head=output(['git','rev-parse','HEAD'])
    paths=[] if old_head==head else output(['git','diff','--name-only',old_head,head]).splitlines()
    actions=changed_actions(paths)
    workspace=pathlib.Path(state['workspace']);env=dict(os.environ,TMPDIR=str(workspace/'tmp'),npm_config_cache=str(workspace/'cache/npm'))
    env['PATH']=str(pathlib.Path(state['node']).parent)+':'+env.get('PATH','')
    before=json.dumps(config,sort_keys=True)
    sync_model_profiles(data,config)
    if actions['dependencies'] or not (ROOT/'offline_harness/node_modules').exists():node_dependencies(state,env)
    if actions['solver_image']:rebuild_solver(config,config_file,env)
    if json.dumps(config,sort_keys=True)!=before:write_json(config_file,config)
    print(json.dumps({'from':old_head,'to':head,'changed':paths,'actions':actions},indent=2))
    print('Update ready. Restart only the frontend with ./mini-ctf; resident model processes are not stopped.')

def pull():
    if output(['git','status','--porcelain','--untracked-files=no']):raise RuntimeError('Tracked source changes are present; commit or stash them before updating')
    old_head=output(['git','rev-parse','HEAD']);upstream=output(['git','rev-parse','--abbrev-ref','--symbolic-full-name','@{u}'])
    remote=upstream.split('/',1)[0]
    run(['git','fetch','--prune',remote],cwd=ROOT)
    run(['git','merge','--ff-only',upstream],cwd=ROOT)
    os.execv(sys.executable,[sys.executable,str(ROOT/'installer/update.py'),'--apply',old_head])

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',metavar='OLD_HEAD');args=parser.parse_args()
    apply(args.apply) if args.apply else pull()

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
