#!/usr/bin/env python3
"""Build and enable the pinned /btw backend without starting a model process."""
import argparse,fcntl,hashlib,json,os,pathlib,platform,re,shutil,subprocess,tempfile
from bootstrap import ROOT,MANIFEST,fetch_asset,unpack,privileged,run,write_json

TOOLKIT=json.loads((ROOT/'installer/cuda-toolkit.json').read_text())
PATCHES=['offline_harness/patches/llama-b12144-kv-cells.patch',
         'offline_harness/patches/llama-b12144-btw.patch',
         'offline_harness/scripts/build-kv-backend.sh']

def output(args,**options):
    return subprocess.check_output(list(map(str,args)),text=True,**options).strip()

def ensure_build_tools():
    missing=[name for name in ['git','cmake','ninja','g++','pkg-config'] if not shutil.which(name)]
    ssl=not shutil.which('pkg-config') or subprocess.run(['pkg-config','--exists','openssl']).returncode!=0
    if missing or ssl:
        print('Preparing backend build tools…',flush=True)
        privileged(['apt-get','update'])
        privileged(['apt-get','install','-y','build-essential','cmake','ninja-build','git','pkg-config','libssl-dev'])

def toolkit_version(directory):
    directory=pathlib.Path(directory)
    if not (directory/'bin/nvcc').is_file() or not (directory/'include/cuda_runtime.h').is_file():return None
    try:
        version=re.search(r'release (\d+)\.(\d+)',output([directory/'bin/nvcc','--version']))
        return tuple(map(int,version.groups())) if version else None
    except (OSError,subprocess.CalledProcessError):return None

def find_toolkit(data,config,explicit=None):
    if explicit:
        directory=pathlib.Path(explicit).expanduser().resolve()
        if (toolkit_version(directory) or (0,0))<(12,8):raise ValueError('--cuda-toolkit requires CUDA Toolkit 12.8 or later')
        return directory
    nvcc=shutil.which('nvcc')
    candidates=[os.environ.get('CUDAToolkit_ROOT'),os.environ.get('CUDA_HOME'),
                str(pathlib.Path(nvcc).resolve().parent.parent) if nvcc else None,
                *[str(pathlib.Path(p).parent) for p in config.get('modelRuntime',{}).get('libraryDirs',[])],
                str(data/'engines'/('cuda-'+TOOLKIT['version']+'-linux')),'/usr/local/cuda']
    for candidate in candidates:
        if candidate and (toolkit_version(candidate) or (0,0))>=(12,8):return pathlib.Path(candidate).resolve()
    return None

def install_toolkit(data):
    target=data/'engines'/('cuda-'+TOOLKIT['version']+'-linux')
    if toolkit_version(target):return target
    if target.exists():raise ValueError('Incomplete CUDA Toolkit directory: '+str(target))
    target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cuda-build-',dir=target.parent) as temp:
        staging=pathlib.Path(temp)/'toolkit';staging.mkdir()
        for name,asset in TOOLKIT['components'].items():
            print('Preparing CUDA component: '+name,flush=True)
            archive=fetch_asset(asset,data/'downloads/btw-cuda')
            extracted=pathlib.Path(temp)/name;unpack(archive,extracted)
            roots=list(extracted.iterdir())
            if len(roots)!=1 or not roots[0].is_dir():raise ValueError('Unexpected CUDA component archive: '+name)
            shutil.copytree(roots[0],staging,dirs_exist_ok=True,symlinks=True)
            license_file=roots[0]/'LICENSE'
            if license_file.is_file():
                licenses=staging/'share/licenses';licenses.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(license_file,licenses/name)
        if not (staging/'lib64').exists():(staging/'lib64').symlink_to('lib',target_is_directory=True)
        if toolkit_version(staging)!=(12,8):raise ValueError('Downloaded CUDA Toolkit did not verify')
        staging.rename(target)
    return target

def architecture():
    if os.environ.get('MINI_CTF_CUDA_ARCH'):return os.environ['MINI_CTF_CUDA_ARCH']
    try:
        values=output(['nvidia-smi','--query-gpu=compute_cap','--format=csv,noheader']).splitlines()
        if values and all(re.fullmatch(r'\d+\.\d+',v.strip()) for v in values):
            return ';'.join(dict.fromkeys(v.strip().replace('.','') for v in values))
    except (OSError,subprocess.CalledProcessError):pass
    return 'native'

def build_identity(toolkit,arch):
    digest=hashlib.sha256()
    for value in [MANIFEST['engine_commit'],str(toolkit),output([toolkit/'bin/nvcc','--version']),arch]:digest.update(value.encode());digest.update(b'\0')
    for name in PATCHES:digest.update((ROOT/name).read_bytes())
    return digest.hexdigest()

def valid_backend(directory,identity):
    receipt=directory/'btw-build.json'
    if not receipt.is_file():return False
    try:
        record=json.loads(receipt.read_text())
        if record['identity']!=identity:return False
        for name,expected in record['files'].items():
            file=directory/name
            if not file.is_file() or file.stat().st_size!=expected['size']:return False
            with file.open('rb') as stream:
                digest=hashlib.sha256()
                for chunk in iter(lambda:stream.read(4*1024*1024),b''):digest.update(chunk)
            if digest.hexdigest()!=expected['sha256']:return False
        return 'llama-server' in record['files'] and any(name.startswith('libggml-cuda.so') for name in record['files'])
    except (ValueError,KeyError,OSError):return False

def install_binaries(build,target,identity):
    if target.exists():raise ValueError('Backend artifact exists but did not verify: '+str(target))
    with tempfile.TemporaryDirectory(prefix='.btw-runtime-',dir=target.parent) as temp:
        staging=pathlib.Path(temp)/'runtime'
        shutil.copytree(build/'bin',staging,symlinks=True)
        records={}
        for file in staging.iterdir():
            if file.is_symlink() or not file.is_file():continue
            digest=hashlib.sha256()
            with file.open('rb') as stream:
                for chunk in iter(lambda:stream.read(4*1024*1024),b''):digest.update(chunk)
            records[file.name]={'size':file.stat().st_size,'sha256':digest.hexdigest()}
        write_json(staging/'btw-build.json',{'identity':identity,'revision':MANIFEST['engine_commit'],'files':records})
        if not valid_backend(staging,identity):raise ValueError('Compiled CUDA backend did not verify')
        staging.rename(target)

def enable_btw_backend(data,config,workspace,cuda_toolkit=None,source_dir=None,build_dir=None):
    if platform.system()!='Linux' or platform.machine() not in ('x86_64','AMD64'):raise ValueError('/btw backend installer requires x86-64 Linux or WSL2')
    data=pathlib.Path(data).resolve();workspace=pathlib.Path(workspace).resolve()
    engines=data/'engines'/MANIFEST['engine_tag'];engines.mkdir(parents=True,exist_ok=True)
    with (engines/'.btw-install.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('Another /btw backend installation is in progress')
        ensure_build_tools()
        toolkit=find_toolkit(data,config,cuda_toolkit) or install_toolkit(data)
        arch=architecture();identity=build_identity(toolkit,arch)
        target=engines/('linux-btw-'+identity[:12])
        if not valid_backend(target,identity):
            cache=workspace/'backend-build';cache.mkdir(parents=True,exist_ok=True)
            source=pathlib.Path(source_dir).resolve() if source_dir else cache/('llama-'+MANIFEST['engine_commit'][:12]+'-'+identity[:12])
            build=pathlib.Path(build_dir).resolve() if build_dir else cache/('btw-'+identity[:12])
            if not source.exists():
                run(['git','init',source]);run(['git','-C',source,'remote','add','origin','https://github.com/ggml-org/llama.cpp.git'])
            try:revision=output(['git','-C',source,'rev-parse','HEAD'])
            except subprocess.CalledProcessError:
                run(['git','-C',source,'fetch','--depth','1','origin',MANIFEST['engine_commit']])
                run(['git','-C',source,'checkout','--detach','FETCH_HEAD']);revision=output(['git','-C',source,'rev-parse','HEAD'])
            if revision!=MANIFEST['engine_commit']:raise ValueError('Backend source is not the pinned llama.cpp revision')
            print('Building /btw CUDA backend; first build can take several minutes…',flush=True)
            run(['sh',ROOT/'offline_harness/scripts/build-kv-backend.sh',source,build,toolkit],env=dict(os.environ,MINI_CTF_CUDA_ARCH=arch))
            install_binaries(build,target,identity)
        else:print('Reusing verified /btw CUDA backend: '+str(target),flush=True)
        previous=config.get('modelRuntime',{})
        libraries=[str(toolkit/'lib'),*[p for p in previous.get('libraryDirs',[]) if pathlib.Path(p).is_dir()]]
        if pathlib.Path('/usr/lib/wsl/lib').is_dir():libraries.append('/usr/lib/wsl/lib')
        config['modelRuntime']={**previous,'exe':str(target/'llama-server'),'platform':'linux',
            'runDir':previous.get('runDir',str(data/'model-runtime-btw-linux')) if previous.get('platform')=='linux' else str(data/'model-runtime-btw-linux'),
            'hostCwd':str(data),'libraryDirs':list(dict.fromkeys(libraries)),
            'btw':{**(previous.get('btw') or {}),'enabled':True}}
        print('/btw backend enabled for the next ./mini-ctf startup.',flush=True)
        return target

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True);parser.add_argument('--data-dir',required=True);parser.add_argument('--workspace',required=True)
    parser.add_argument('--cuda-toolkit');parser.add_argument('--source-dir');parser.add_argument('--build-dir');args=parser.parse_args()
    file=pathlib.Path(args.config);before=file.read_bytes();config=json.loads(before)
    enable_btw_backend(args.data_dir,config,args.workspace,args.cuda_toolkit,args.source_dir,args.build_dir)
    if file.read_bytes()!=before:raise ValueError('Configuration changed while the backend was building; retry the installation')
    write_json(file,config)

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
