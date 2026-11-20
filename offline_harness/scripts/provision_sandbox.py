#!/usr/bin/env python3
"""Provision a NEW offline solver only; never pulls images or changes an existing container."""
import argparse, json, pathlib, subprocess, uuid, os

def provision(docker, host, image, work_base, work_dir=None, *, memory_mib=6144, cpus=6, pids=None, tmp_mib=None):
    base=pathlib.Path(work_base).resolve()
    if '/offline-harness/work' not in str(base) or '/benchmarks/' in str(base):
        raise ValueError('Use the dedicated offline-harness/work directory')
    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'DOCKER_HOST':host}
    def call(*args):
        return subprocess.run([docker,*args],env=env,check=True,capture_output=True,text=True,timeout=30).stdout.strip()
    pinned=json.loads(call('image','inspect',image))[0]['Id']
    ident='offline-harness-'+uuid.uuid4().hex[:12]
    work=pathlib.Path(work_dir).resolve(strict=True) if work_dir else base/ident
    if not work.is_relative_to(base) or work==base:raise ValueError('Work directory must be inside the dedicated work base')
    if not work_dir:work.mkdir(parents=True,exist_ok=False)
    if not work.is_dir():raise ValueError('Work directory is not a directory')
    # An explicit public export can be sealed 0555.  Its root is nevertheless
    # the solver workspace; keep nested public inputs read-only while making
    # the root owner-writable for retained jobs and analysis output.
    os.chown(work,os.getuid(),os.getgid())
    os.chmod(work,0o700)
    cid=call('run','-d','--name',ident,'--label','qwen.offline-harness=true','--network','none',
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--memory',str(memory_mib)+'m','--memory-swap',str(memory_mib)+'m',
        '--cpus',str(cpus),'--pids-limit','-1','--tmpfs','/tmp:rw,nosuid,nodev,size=0',
        '--mount',f'type=bind,src={work},dst=/work','--workdir','/work',pinned,'sleep','infinity')
    return {'docker':docker,'dockerHost':host,'containerId':cid,'imageId':pinned,'workDir':str(work)}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--docker',required=True);p.add_argument('--host',required=True);p.add_argument('--image',required=True)
    p.add_argument('--work-base',required=True);p.add_argument('--out',type=pathlib.Path,required=True)
    p.add_argument('--work-dir',help='Explicit previously exported public input-files directory, never a prior solver workspace')
    p.add_argument('--memory-mib',type=int,default=6144);p.add_argument('--cpus',type=float,default=6)
    # Accept legacy flags without reintroducing the removed limits.
    p.add_argument('--pids',type=int,help='Deprecated; ignored (no process quota)')
    p.add_argument('--tmp-mib',type=int,help='Deprecated; ignored (no tmpfs size quota)')
    args=p.parse_args()
    if args.out.exists():raise SystemExit('Refusing to overwrite a sandbox receipt')
    receipt=provision(args.docker,args.host,args.image,args.work_base,args.work_dir,memory_mib=args.memory_mib,cpus=args.cpus,pids=args.pids,tmp_mib=args.tmp_mib)
    args.out.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
