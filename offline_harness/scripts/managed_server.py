#!/usr/bin/env python3
"""Launch or replace only the Linux model process recorded by this installation."""
import json,os,pathlib,signal,subprocess,sys,time,urllib.request,uuid

def identity(pid):
    try:
        stat=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
        return {'pid':pid,'start_ticks':int(stat[19]),'exe':os.readlink(f'/proc/{pid}/exe'),'state':stat[0]}
    except (OSError,ValueError):return None

def atomic(file,value):
    tmp=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(value));tmp.replace(file)

def main(config):
    c=json.loads(pathlib.Path(config).read_text());root=pathlib.Path(c['root']);root.mkdir(parents=True,exist_ok=True);owner=root/'owner.json'
    if owner.exists():
        prior=json.loads(owner.read_text());live=identity(prior['pid'])
        if live and live['state']!='Z':
            if any(live[k]!=prior[k] for k in ['start_ticks','exe']):raise RuntimeError('Model owner identity changed')
            if prior['key']==c['key']:return
            os.killpg(prior['pid'],signal.SIGTERM)
            for _ in range(100):
                observed=identity(prior['pid'])
                if not observed or observed['state']=='Z':break
                time.sleep(.1)
            else:os.killpg(prior['pid'],signal.SIGKILL)
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
    try:main(sys.argv[1])
    except Exception as error:
        c=json.loads(pathlib.Path(sys.argv[1]).read_text());atomic(pathlib.Path(c['root'])/'launch-failed.json',{'requestId':c['requestId'],'error':str(error)});raise
