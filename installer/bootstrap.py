#!/usr/bin/env python3
"""Install pinned assets, model, Node dependencies and an isolated solver environment."""
import argparse,hashlib,json,os,pathlib,platform,shutil,subprocess,sys,tarfile,urllib.request,zipfile,time,stat,re
ROOT=pathlib.Path(__file__).resolve().parent.parent
MANIFEST=json.loads((ROOT/'installer/assets.json').read_text())

def sha256(file):
    file=pathlib.Path(file).resolve()
    if os.environ.get('WSL_DISTRO_NAME') and str(file).startswith('/mnt/'):
        convert=lambda p:subprocess.check_output(['wslpath','-w',str(p)],text=True).strip()
        windows_file=convert(file)
        if re.match(r'^[A-Za-z]:\\',windows_file):
            script=file.parent/'.mini-ctf-sha256.ps1';shutil.copyfile(ROOT/'installer/hash-file.ps1',script)
            try:
                return subprocess.check_output(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',convert(script),'-Path',windows_file],cwd=file.parent,env=interop_env(),text=True,timeout=1200).strip().lower()
            finally:script.unlink(missing_ok=True)
    h=hashlib.sha256()
    with pathlib.Path(file).open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def fetch_asset(asset,directory):
    directory=pathlib.Path(directory);directory.mkdir(parents=True,exist_ok=True);file=directory/asset['name'];partial=file.with_name(file.name+'.part')
    if file.exists():
        if sha256(file)!=asset['sha256']:raise ValueError('Checksum mismatch: '+str(file))
        return file
    for attempt in range(5):
        try:
            offset=partial.stat().st_size if partial.exists() else 0
            headers={'User-Agent':'mini-ctf-harness/1','Range':f'bytes={offset}-'} if offset else {'User-Agent':'mini-ctf-harness/1'}
            with urllib.request.urlopen(urllib.request.Request(asset['url'],headers=headers),timeout=60) as response:
                if response.status==206 and not response.headers.get('Content-Range','').startswith(f'bytes {offset}-'):raise ValueError('Unexpected resumed byte range')
                append=offset>0 and response.status==206
                with partial.open('ab' if append else 'wb') as out:
                    while True:
                        data=response.read(4*1024*1024)
                        if not data:break
                        out.write(data)
            if asset.get('size') and partial.stat().st_size!=asset['size']:raise ValueError('Incomplete download: '+asset['name'])
            if sha256(partial)!=asset['sha256']:raise ValueError('Checksum mismatch: '+asset['name'])
            partial.replace(file);return file
        except (OSError,TimeoutError):
            if attempt==4:raise
            time.sleep(2**attempt)
    raise RuntimeError('Download failed')

def unpack(file,destination):
    destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
    if zipfile.is_zipfile(file):
        with zipfile.ZipFile(file) as archive:
            for item in archive.infolist():
                if not (destination/item.filename).resolve().is_relative_to(destination.resolve()):raise ValueError('Archive path escaped installation')
            archive.extractall(destination)
    else:
        with tarfile.open(file) as archive:
            for item in archive.getmembers():
                if not (destination/item.name).resolve().is_relative_to(destination.resolve()):raise ValueError('Archive path escaped installation')
                if item.issym() or item.islnk():
                    base=(destination/item.name).parent if item.issym() else destination
                    if not (base/item.linkname).resolve().is_relative_to(destination.resolve()):raise ValueError('Archive link escaped installation')
            archive.extractall(destination)

def run(args,**options):
    print('+ '+' '.join(map(str,args)),flush=True);subprocess.run(list(map(str,args)),check=True,**options)

def interop_env(env=None):
    env=dict(os.environ if env is None else env)
    if os.environ.get('WSL_DISTRO_NAME') and pathlib.Path('/run/WSL/1_interop').exists():
        env['WSL_INTEROP']='/run/WSL/1_interop'
    elif os.environ.get('WSL_DISTRO_NAME') and not pathlib.Path(env.get('WSL_INTEROP','/nonexistent')).exists():
        sockets=[p for p in pathlib.Path('/run/WSL').glob('*_interop') if p.exists() and p.is_socket()]
        if sockets:env['WSL_INTEROP']=str(max(sockets,key=lambda p:p.stat().st_mtime))
    return env

def privileged(args,**options):
    options['env']=interop_env(options.get('env'))
    if os.environ.get('WSL_DISTRO_NAME'):
        args=['/mnt/c/Windows/System32/wsl.exe','--distribution',os.environ['WSL_DISTRO_NAME'],'--user','root','--exec','nsenter','--mount=/proc/1/ns/mnt','--',*map(str,args)]
        options['cwd']='/mnt/c'
    elif os.geteuid()!=0:args=['sudo',*map(str,args)]
    return subprocess.check_output(list(map(str,args)),text=True,**options).strip()

def write_json(file,value):
    file=pathlib.Path(file);file.parent.mkdir(parents=True,exist_ok=True);tmp=file.with_suffix(file.suffix+'.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.replace(file)

def install(args):
    if platform.machine() not in ('x86_64','AMD64'):raise ValueError('The pinned installation profile requires x86-64')
    data=pathlib.Path(args.data_dir).expanduser().resolve();wsl=bool(os.environ.get('WSL_DISTRO_NAME'));host='windows' if wsl else 'linux';assets=MANIFEST['assets']
    plan={'data_dir':str(data),'profile':args.model,'platform':host,'assets':[assets[k] for k in ['node','docker','compose',host+'-engine',host+'-cuda',args.model]],'steps':['prepare Linux storage','install Node and Docker binaries','npm ci','build solver image','verify model and engine','write config']}
    if args.plan:print(json.dumps(plan,indent=2));return
    data.mkdir(parents=True,exist_ok=True)
    if wsl:
        windows_data=subprocess.check_output(['wslpath','-w',str(data)],text=True).strip()
        if not re.match(r'^[A-Za-z]:\\',windows_data):raise ValueError('On WSL, --data-dir must be on a Windows data drive')
    missing=[name for name in ['findmnt','mkfs.ext4','iptables-legacy','ip','systemctl'] if not shutil.which(name)]
    if missing:
        print('Installing required Ubuntu system packages: '+', '.join(missing),flush=True)
        cache=data/'os-cache';cache.mkdir(exist_ok=True)
        privileged(['apt-get','update'])
        privileged(['apt-get','-o','Dir::Cache::Archives='+str(cache),'install','-y','ca-certificates','e2fsprogs','iptables','iproute2','libgomp1','libnuma1','libcurl4'])
    work=pathlib.Path(privileged(['python3',ROOT/'installer/storage.py',data,'--uid',os.getuid(),'--gid',os.getgid(),'--size-gib',args.workspace_gib]))
    if not (work/'tmp').is_dir():
        if wsl and os.environ.get('MINI_CTF_MOUNT_ENTERED')!='1':
            os.environ['MINI_CTF_ENTER_MOUNT']='1';os.execv(sys.executable,[sys.executable,str(ROOT/'mini-ctf'),'install',*sys.argv[1:]])
        raise ValueError('Workspace mount is not visible in this namespace')
    cache=data/'downloads';env=dict(os.environ,TMPDIR=str(work/'tmp'),npm_config_cache=str(work/'cache/npm'))
    node=shutil.which('node');npm=shutil.which('npm')
    if not node or not npm or subprocess.check_output([node,'-p','process.versions.node'],text=True).strip()!='22.22.1':
        unpack(fetch_asset(assets['node'],cache),work/'bin');node=str(work/'bin/node-v22.22.1-linux-x64/bin/node');npm=str(pathlib.Path(node).with_name('npm'))
    env['PATH']=str(pathlib.Path(node).parent)+':'+env.get('PATH','')
    docker=args.docker or str(work/'bin/docker/docker');dockerd=args.dockerd or str(work/'bin/docker/dockerd')
    if not args.docker:unpack(fetch_asset(assets['docker'],cache),work/'bin')
    plugin=work/'bin/docker/cli-plugins';plugin.mkdir(parents=True,exist_ok=True);compose=fetch_asset(assets['compose'],cache);shutil.copyfile(compose,plugin/'docker-compose');(plugin/'docker-compose').chmod(0o755)
    modules=ROOT/'offline_harness/node_modules'
    if modules.is_symlink():modules.unlink()
    run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=ROOT/'offline_harness',env=env)
    config={'contestDir':str(work/'sessions'),'modelLease':str(work/'model-lease.json'),'autoStart':True,'environment':'offline','hostCwd':str(data),'wslDistribution':os.environ.get('WSL_DISTRO_NAME'),
      'runtime':{'root':str(work/'runtime'),'execRoot':str(work/'dx'),'docker':docker,'dockerd':dockerd,'composeDir':str(plugin),'solverImage':args.solver_image or 'mini-ctf-tools:1','solverArchive':str(data/'assets/solver.tar')},
      'provision':{'workBase':str(work/'offline-harness/work')},'solver':{'memoryMiB':512,'cpus':1,'pids':128,'tmpMiB':128},'environments':{'offline':{'type':'offline'},'lan':{'type':'lan','targetUrl':''}},'services':{},'uid':os.getuid(),'gid':os.getgid(),
      'model':{'mode':'memory-skills','model':args.model,'baseUrl':'http://127.0.0.1:'+str(args.port),'contextTokens':55296,'promptTokens':40960,'compactSoftTokens':40960,'generationTokens':8192,'reasoningTokens':-1,'reasoningEffort':'medium','safetyTokens':0,'compactThinking':True,'compactReasoningEffort':'xhigh','compactReasoningTokens':4096,'compactTokens':8192,'maxTurns':10000,'maxGeneratedTokens':10000000,'maxSeconds':7200,'nativeImages':False,'kv':{'enabled':False,'slot':0}}}
    prior_file=data/'config.json'
    if prior_file.exists():
        prior=json.loads(prior_file.read_text())
        for key in ['model','solver','environments','services','importLimits']:
            if key in prior:config.setdefault(key,{}).update(prior[key])
    if args.docker_host:config['runtime']['dockerHost']=args.docker_host
    file=data/'config.json';write_json(file,config);helper=ROOT/'offline_harness/scripts/interactive_environment.py'
    privileged(['python3',helper,'daemon','--config',file],env=env)
    docker_env=dict(env,DOCKER_HOST=args.docker_host or 'unix://'+str(work/'runtime/run/docker.sock'),DOCKER_CONFIG=str(work/'runtime/docker-config'))
    if not args.solver_image:run([docker,'build','--pull','--tag','mini-ctf-tools:1',ROOT/'docker'],env=docker_env)
    config['runtime']['solverImage']=json.loads(subprocess.check_output([docker,'image','inspect',config['runtime']['solverImage']],env=docker_env,text=True))[0]['Id']
    model=pathlib.Path(args.model_file).resolve() if args.model_file else fetch_asset(assets[args.model],data/'models')
    print('Verifying pinned model SHA256: '+str(model),flush=True)
    if sha256(model)!=assets[args.model]['sha256']:raise ValueError('Model checksum mismatch')
    engine=pathlib.Path(args.runtime_exe).resolve() if args.runtime_exe else None
    if not engine:
        runtime=data/'engines'/MANIFEST['engine_tag']/host
        for key in [host+'-engine',host+'-cuda']:unpack(fetch_asset(assets[key],cache),runtime)
        engine=next(runtime.rglob('llama-server.exe' if wsl else 'llama-server'))
    config['modelRuntime']={'exe':str(engine),'runDir':str(data/'model-runtime'),'hostCwd':str(data),'platform':host,'libraryDirs':sorted({str(p.parent) for p in engine.parent.parent.rglob('*.so*')}) if not wsl else []}
    config['models']=[{'id':args.model,'name':'Qwen3.8 27B IQ4_XS','modelPath':str(model),'contextTokens':55296,'kvType':'q8_0'}]
    if wsl and (not str(engine).startswith('/mnt/') or not str(model).startswith('/mnt/')):raise ValueError('Windows model assets must be on a Windows-mounted data drive')
    write_json(file,config)
    write_json(ROOT/'.install.json',{'data_dir':str(data),'workspace':str(work),'node':node,'config':str(file)})
    print('Installed. Start with: ./mini-ctf\nConfiguration: '+str(file))

def parser():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data-dir',default=os.environ.get('MINI_CTF_DATA',str(ROOT/'.mini-ctf')));p.add_argument('--model',default='qwen3.8-27b-iq4xs',choices=['qwen3.8-27b-iq4xs']);p.add_argument('--plan',action='store_true');p.add_argument('--workspace-gib',type=int,default=24);p.add_argument('--port',type=int,default=8080);p.add_argument('--model-file');p.add_argument('--runtime-exe');p.add_argument('--docker');p.add_argument('--dockerd');p.add_argument('--docker-host');p.add_argument('--solver-image');return p

if __name__=='__main__':
    try:install(parser().parse_args())
    except Exception as error:raise SystemExit(str(error))
