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

def checked_process(prior):
    live=identity(prior['pid'])
    if not live or live['state']=='Z':return None
    if any(live[k]!=prior[k] for k in ('start_ticks','exe')):
        raise RuntimeError('Model owner identity changed; process was not stopped')
    return prior

def owned_process(owner):
    return checked_process(json.loads(owner.read_text())) if owner.exists() else None

def signal_owned(prior,sig):
    if not checked_process(prior):return
    try:
        if os.getpgid(prior['pid'])!=prior['pid']:
            raise RuntimeError('Model is not its recorded process group leader; process was not stopped')
        os.killpg(prior['pid'],sig)
    except ProcessLookupError:pass

def wait_stopped(prior,seconds):
    deadline=time.monotonic()+seconds
    while checked_process(prior):
        if time.monotonic()>=deadline:return False
        time.sleep(.05)
    return True

def stop_owned(prior,grace_seconds=10,kill_seconds=5):
    if not prior:return
    signal_owned(prior,signal.SIGTERM)
    if wait_stopped(prior,grace_seconds):return
    # Recheck identity before escalation; never signal a recycled PID.
    signal_owned(prior,signal.SIGKILL)
    if not wait_stopped(prior,kill_seconds):raise RuntimeError('Owned model has not exited')

def selected(c,root):
    try:return json.loads((root/'selection.json').read_text())['requestId']==c['requestId']
    except FileNotFoundError:return False

def still_owned(owner,current):
    try:
        record=json.loads(owner.read_text())
        return all(record.get(k)==current[k] for k in ('pid','start_ticks','requestId'))
    except FileNotFoundError:return False

def launch(c,root,owner):
    # A delayed detached launcher must not resurrect a stopped/superseded request.
    if not selected(c,root):return None
    prior=owned_process(owner)
    if prior and prior['key']==c['key']:
        # Acknowledge reuse without changing the process identity used by RAM KV.
        prior['selectionId']=c['requestId'];atomic(owner,prior)
        return None,prior
    stop_owned(prior)
    owner.unlink(missing_ok=True)
    if not selected(c,root):return None
    run=root/('run-'+c['requestId']);run.mkdir();env=dict(os.environ,TMPDIR=str(run),CUDA_CACHE_PATH=str(run/'cuda-cache'),LD_LIBRARY_PATH=':'.join([str(pathlib.Path(c['exe']).parent),*c.get('libraryDirs',[]),os.environ.get('LD_LIBRARY_PATH','')]))
    with (run/'stdout.log').open('wb') as out,(run/'stderr.log').open('wb') as err:
        p=subprocess.Popen([c['exe'],*c['args']],stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True,env=env)
    live=identity(p.pid)
    if not live or live['state']=='Z':
        p.wait();raise RuntimeError('Model exited; see '+str(run/'stderr.log'))
    current={**c,**live,'run':str(run),'selectionId':c['requestId']};atomic(owner,current)
    return p,current

def wait_ready(c,owner,p,current):
    run=pathlib.Path(current['run'])
    health_client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(1200):
        if not selected(c,owner.parent) or not still_owned(owner,current):
            if p:p.poll()
            return
        if (p and p.poll() is not None) or not checked_process(current):
            raise RuntimeError('Model exited; see '+str(run/'stderr.log'))
        try:
            with health_client.open(c['baseUrl']+'/health',timeout=1) as r:
                if json.load(r).get('status')=='ok':return
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError('Model startup timed out; see '+str(run))

def lifecycle_lock(root):
    lock=(root/'lifecycle.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX)
    return lock

if __name__=='__main__':
    stopping=sys.argv[1]=='--stop'
    c=None if stopping else json.loads(pathlib.Path(sys.argv[1]).read_text())
    root=pathlib.Path(sys.argv[2] if stopping else c['root'])
    if not stopping:root.mkdir(parents=True,exist_ok=True)
    if root.exists():
        owner=root/'owner.json'
        try:
            pending=None
            with lifecycle_lock(root):
                if stopping:
                    (root/'selection.json').unlink(missing_ok=True)
                    stop_owned(owned_process(owner))
                    owner.unlink(missing_ok=True)
                else:
                    pending=launch(c,root,owner)
            # Health polling must not block /model or /close-server.
            if pending:wait_ready(c,owner,*pending)
        except Exception as error:
            if not stopping:
                with lifecycle_lock(root):
                    if selected(c,root):
                        atomic(root/'launch-failed.json',{'requestId':c['requestId'],'error':str(error)})
            raise
