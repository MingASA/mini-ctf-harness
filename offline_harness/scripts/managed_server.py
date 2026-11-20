#!/usr/bin/env python3
"""Launch or replace only the Linux model process recorded by this installation."""
import fcntl,json,os,pathlib,signal,subprocess,sys,time,urllib.request,uuid

def identity(pid):
    try:
        stat=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
        return {'pid':pid,'start_ticks':int(stat[19]),'exe':os.readlink(f'/proc/{pid}/exe'),'state':stat[0]}
    except (OSError,ValueError):return None

def atomic(file,value):
    tmp=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(value));tmp.replace(file)

def owned_process(owner):
    if not owner.exists():return None
    prior=json.loads(owner.read_text());live=identity(prior['pid'])
    if not live or live['state']=='Z':return None
    if any(live[k]!=prior[k] for k in ('start_ticks','exe')):
        raise RuntimeError('Model owner identity changed; process was not stopped')
    return prior

def stop_owned(prior):
    if not prior:return
    pid=prior['pid']
    try:os.killpg(pid,signal.SIGTERM)
    except ProcessLookupError:return
    for _ in range(300):
        live=identity(pid)
        if not live or live['state']=='Z' or live['start_ticks']!=prior['start_ticks']:return
        time.sleep(.1)
    raise RuntimeError('Owned model has not exited')

def main(c,root,owner):
    prior=owned_process(owner)
    if prior and prior['key']==c['key']:return
    stop_owned(prior)
    run=root/('run-'+c['requestId']);run.mkdir();env=dict(os.environ,TMPDIR=str(run),CUDA_CACHE_PATH=str(run/'cuda-cache'),LD_LIBRARY_PATH=':'.join([str(pathlib.Path(c['exe']).parent),*c.get('libraryDirs',[]),os.environ.get('LD_LIBRARY_PATH','')]))
    with (run/'stdout.log').open('wb') as out,(run/'stderr.log').open('wb') as err:
        p=subprocess.Popen([c['exe'],*c['args']],stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True,env=env)
    current=identity(p.pid);atomic(owner,{**c,**current,'run':str(run)})
    for _ in range(1200):
        if p.poll() is not None:raise RuntimeError('Model exited; see '+str(run/'stderr.log'))
        try:
            with urllib.request.urlopen(c['baseUrl']+'/health',timeout=1) as r:
                if json.load(r).get('status')=='ok':return
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError('Model startup timed out; see '+str(run))

if __name__=='__main__':
    stopping=sys.argv[1]=='--stop'
    c=None if stopping else json.loads(pathlib.Path(sys.argv[1]).read_text())
    root=pathlib.Path(sys.argv[2] if stopping else c['root'])
    if not stopping:root.mkdir(parents=True,exist_ok=True)
    if root.exists():
        owner=root/'owner.json'
        try:
            with (root/'lifecycle.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if stopping:
                    stop_owned(owned_process(owner))
                    owner.unlink(missing_ok=True)
                else:
                    main(c,root,owner)
        except Exception as error:
            if not stopping:
                atomic(root/'launch-failed.json',{'requestId':c['requestId'],'error':str(error)})
            raise
