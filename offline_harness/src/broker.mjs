import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hash} from './store.mjs';
import {validateNetworkPolicy,verifyEgress} from './network-policy.mjs';
const exec = promisify(execFile);
const JOB_STORAGE_PREFLIGHT_COMMAND='printf offline-harness-job-storage-preflight';
const JOB_STORAGE_PREFLIGHT_OUTPUT='offline-harness-job-storage-preflight';

const errorText=error=>[error?.stderr,error?.message].filter(value=>typeof value==='string').join('\n');
const jobStorageFailure=error=>errorText(error).match(/Job storage unavailable:\s*([^\r\n]+)/)?.[1];

export function validateSandbox(container, networks, config) {
  const h=container.HostConfig || {};
  if(container.Id!==config.containerId || container.Image!==config.imageId || !container.State?.Running) throw Error('Sandbox identity or state changed');
  if(h.Privileged || h.PidMode==='host' || h.IpcMode==='host' || h.NetworkMode==='host' || h.CapAdd?.length || h.Devices?.length || h.DeviceRequests?.length) throw Error('Privileged sandbox denied');
  if(!h.CapDrop?.some(x=>x.toUpperCase()==='ALL') || !h.SecurityOpt?.some(x=>x.startsWith('no-new-privileges'))) throw Error('Missing sandbox privilege restrictions');
  if(!h.Memory || h.Memory>4096*1024*1024 || !h.PidsLimit || h.PidsLimit>256) throw Error('Missing sandbox resource limits');
  if(!h.ReadonlyRootfs) throw Error('Sandbox root filesystem must be read-only');
  if(container.Mounts.length!==1 || container.Mounts[0].Destination!=='/work' || container.Mounts[0].Source!==config.workDir || container.Mounts[0].Type!=='bind') throw Error('Unexpected sandbox mount');
  validateNetworkPolicy(container,networks,config);
  if(h.PortBindings && Object.keys(h.PortBindings).length) throw Error('Sandbox port publishing denied');
  return true;
}

// All process controls run inside the sandbox. Group identity includes Linux
// start ticks, so a reused PID is never treated as the retained command.
const CONTROL = String.raw`
import os,sys,json,pathlib,time,signal,fcntl,tempfile
from contextlib import contextmanager
def atomic(root,name,value):
 fd,tmp=tempfile.mkstemp(prefix='.'+name+'.',dir=root)
 with os.fdopen(fd,'w') as stream:
  json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
 os.replace(tmp,root/name)
 fd=os.open(root,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
@contextmanager
def locked(root):
 with (root/'control.lock').open('a+b') as stream:
  fcntl.flock(stream,fcntl.LOCK_EX)
  yield

def identity(pid):
 try:
  fields=pathlib.Path('/proc/'+str(int(pid))+'/stat').read_text().rsplit(') ',1)[1].split()
  return {'pid':int(pid),'ppid':int(fields[1]),'pgid':int(fields[2]),'session':int(fields[3]),'start_ticks':int(fields[19]),'state':fields[0]}
 except (OSError,ValueError,IndexError):return None

def matches(record,current):
 return bool(record and current and all(record.get(k)==current.get(k) for k in ('pid','pgid','session','start_ticks')))

def signal_child(record,sig):
 if not record or record.get('pid')!=record.get('pgid') or record.get('pid')!=record.get('session'):
  raise ValueError('Command is not its recorded session/group leader')
 current=identity(record['pid'])
 if current is None:return False
 if not matches(record,current):raise ValueError('Child PID identity changed; refusing to signal')
 try:os.killpg(record['pgid'],sig);return True
 except ProcessLookupError:return False

def job_root(jid,work):
 if len(jid)!=32 or any(c not in '0123456789abcdef' for c in jid):raise ValueError('Invalid job ID')
 return pathlib.Path(work)/'.offline-jobs'/jid
`;
const WORKER = CONTROL+String.raw`
import subprocess,resource,threading,base64
root=pathlib.Path(sys.argv[1]);command=base64.b64decode(sys.argv[2],validate=True).decode('utf-8');seconds=int(sys.argv[3]);work=sys.argv[4]
# Legitimate task files may exceed the independent8MiB-per-stream log allowance.
resource.setrlimit(resource.RLIMIT_FSIZE,(1024*1024*1024,1024*1024*1024))
log_limit=8*1024*1024;log_seen={'stdout':0,'stderr':0};readers=[]
def capture(pipe,output,name):
 kept=0
 try:
  while True:
   data=pipe.read(65536)
   if not data:break
   log_seen[name]+=len(data)
   accepted=data[:max(0,log_limit-kept)]
   if accepted:output.write(accepted);output.flush();kept+=len(accepted)
 finally:pipe.close()
def finished_record(value):
 for reader in readers:reader.join(timeout=1)
 for name in ['stdout','stderr']:
  value[name+'_capture_limit_bytes']=log_limit
  value[name+'_discarded_bytes']=max(0,log_seen[name]-log_limit)
  value[name+'_capture_truncated']=log_seen[name]>log_limit
 return value
supervisor=identity(os.getpid());started=time.time();child=None;stop_reason=None;stop_at=None
with (root/'stdout').open('wb') as out,(root/'stderr').open('wb') as err:
 with locked(root):
  if (root/'cancel.json').exists():
   atomic(root,'status.json',{'status':'cancelled','exit_code':None,'launched':False,'finished':time.time()});sys.exit(0)
  p=subprocess.Popen(['bash','-o','pipefail','-lc',command],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0,start_new_session=True)
  for pipe,output,name in [(p.stdout,out,'stdout'),(p.stderr,err,'stderr')]:
   reader=threading.Thread(target=capture,args=(pipe,output,name),daemon=True);reader.start();readers.append(reader)
  child=identity(p.pid)
  if child is None:raise RuntimeError('Missing unreaped child identity')
  state={'status':'running','pid':os.getpid(),'supervisor':supervisor,'child':child,'started':started}
  atomic(root,'status.json',state)
 deadline=time.monotonic()+seconds
 while True:
  with locked(root):
   cancelled=(root/'cancel.json').exists()
   if cancelled:stop_reason='cancelled'
   elif stop_reason is None and time.monotonic()>=deadline:stop_reason='timeout'
   current=identity(child['pid'])
   if current and not matches(child,current):raise RuntimeError('Child identity changed')
   if stop_reason and stop_at is None:
    signal_child(child,signal.SIGTERM);stop_at=time.monotonic()
    atomic(root,'status.json',{**state,'status':'cancelling' if stop_reason=='cancelled' else 'terminating','stop_reason':stop_reason})
   if stop_at is not None:
    # Keep the session leader unreaped, even if already a zombie, until group
    # escalation. Its PID/start ticks cannot be recycled during this interval.
    if time.monotonic()-stop_at>=2:
     signal_child(child,signal.SIGKILL)
     code=p.wait()
     atomic(root,'status.json',finished_record({**state,'status':'cancelled' if stop_reason=='cancelled' else 'finished','exit_code':code if stop_reason=='cancelled' else 124,'timed_out':stop_reason=='timeout','finished':time.time()}))
     break
   elif current is None or current['state']=='Z':
    code=p.wait()
    atomic(root,'status.json',finished_record({**state,'status':'finished','exit_code':code,'finished':time.time()}))
    break
  time.sleep(.05)
`;
const START = CONTROL+String.raw`
import subprocess,hashlib,base64
jid,encoded,seconds=sys.argv[1],sys.argv[2],int(sys.argv[3]);work=sys.argv[4] if len(sys.argv)>4 else '/work'
command=base64.b64decode(encoded,validate=True).decode('utf-8')
root=job_root(jid,work)
try:
 root.parent.mkdir(exist_ok=True)
 if root.exists():
  if (root/'command.sha256').read_text()!=hashlib.sha256(command.encode()).hexdigest():raise ValueError('Job command changed')
  print(json.dumps({'job_id':jid,'existing':True}));sys.exit(0)
 root.mkdir();(root/'command.sha256').write_text(hashlib.sha256(command.encode()).hexdigest())
 atomic(root,'status.json',{'status':'starting','job_id':jid})
except OSError as error:
 raise RuntimeError('Job storage unavailable: '+str(error)) from error
`+'\nworker='+JSON.stringify(WORKER)+String.raw`
p=subprocess.Popen(['python3','-c',worker,str(root),encoded,str(seconds),work],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
atomic(root,'launcher.json',{'supervisor':identity(p.pid)})
print(json.dumps({'job_id':jid,'supervisor_pid':p.pid}))
`;
const READ = CONTROL+String.raw`
root=job_root(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else '/work')
if not root.is_dir() or not (root/'status.json').is_file():
 print(json.dumps({'status':'job_missing','error':'No retained job record exists'}));sys.exit(0)
if len(sys.argv)>6 and sys.argv[6]:
 if not (root/'command.sha256').is_file():
  print(json.dumps({'status':'job_missing','error':'No retained job record exists'}));sys.exit(0)
 if (root/'command.sha256').read_text()!=sys.argv[6]:raise ValueError('Retained command identity changed')
wait=int(sys.argv[5]) if len(sys.argv)>5 else 0
if not 0<=wait<=120:raise ValueError('Wait must be 0..120 seconds')
deadline=time.monotonic()+wait
while True:
 with locked(root):
  pending=json.loads((root/'status.json').read_text())
  record=pending.get('supervisor')
  if not record and (root/'launcher.json').exists():record=json.loads((root/'launcher.json').read_text()).get('supervisor')
  current=identity(record['pid']) if record else None
  alive=not record or bool(matches(record,current) and current['state']!='Z')
 remaining=deadline-time.monotonic()
 if pending['status'] not in ('starting','running','cancelling','terminating') or not alive or remaining<=0:break
 time.sleep(min(.05,remaining))
with locked(root):
 state=json.loads((root/'status.json').read_text());state['job_id']=sys.argv[1]
 record=state.get('supervisor')
 if not record and (root/'launcher.json').exists():record=json.loads((root/'launcher.json').read_text()).get('supervisor')
 current=identity(record['pid']) if record else None
 if state['status'] in ('starting','running','cancelling','terminating') and record and (not matches(record,current) or current['state']=='Z'):
  state.update(status='unknown_exit',exit_code=None)
 for name in ['stdout','stderr']:
  p=root/name
  requested=int(sys.argv[3 if name=='stdout' else 4]) if len(sys.argv)>4 else 0
  if requested<0:raise ValueError('Negative output offset')
  total=p.stat().st_size if p.exists() else 0
  offset=requested if requested<=total else 0
  raw=b''
  if p.exists():
   with p.open('rb') as stream:stream.seek(offset);raw=stream.read(65536)
  import codecs
  decoder=codecs.getincrementaldecoder('utf-8')(errors='replace')
  state[name]=decoder.decode(raw,final=offset+len(raw)>=total)
  consumed=len(raw)-len(decoder.getstate()[0])
  state[name+'_offset']=offset;state[name+'_next_offset']=offset+consumed
  state[name+'_reset']=requested>total
  state[name+'_bytes']=total
  state[name+'_truncated']=offset+consumed<total
  state[name+'_path']=str(p)
print(json.dumps(state))
`;
const CANCEL = CONTROL+String.raw`
root=job_root(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else '/work')
with locked(root):
 state=json.loads((root/'status.json').read_text())
 if state['status'] in ('finished','cancelled','unknown_exit'):
  print(json.dumps({'job_id':sys.argv[1],'status':state['status'],'already_terminal':True}));sys.exit(0)
 if state['status'] not in ('starting','running','cancelling','terminating'):raise ValueError('Unknown retained job state')
 if state['status']!='starting' and not state.get('child'):raise ValueError('Legacy job lacks child identity; cannot safely cancel')
 # The marker is durable before signaling. The worker checks under this same
 # lock before launch, throughout execution and when choosing terminal status.
 atomic(root,'cancel.json',{'requested':time.time(),'job_id':sys.argv[1]})
 sent=signal_child(state['child'],signal.SIGTERM) if state.get('child') else False
 print(json.dumps({'job_id':sys.argv[1],'status':'cancel_requested','signal_sent':sent}))
`;
// Exported for CPU-only supervisor tests; the broker always uses /work.
export const JOB_SCRIPTS = Object.freeze({start:START,read:READ,cancel:CANCEL,worker:WORKER,control:CONTROL});

export class DockerBroker {
  constructor(config, store, execute=exec) {
    this.config=config;this.store=store;this.execute=execute;
    this.jobStoragePreflight=undefined;
    if(!config.workDir.includes('/offline-harness/work/') || config.workDir.includes('/benchmarks/')) throw Error('Development sandbox must use its own offline-harness/work directory');
    if(fs.realpathSync(config.workDir)!==config.workDir) throw Error('Work directory must be canonical');
  }
  async docker(args, options={}) {
    if(args[0]==='exec') {
      // cap-drop ALL removes root's DAC override. Public exports deliberately
      // remain 0700, so tool processes must run as their bind-mount owner.
      const owner=fs.statSync(this.config.workDir);
      args=['exec','--user',`${owner.uid}:${owner.gid}`,'--env','HOME=/work',...args.slice(1)];
    }
    const r=await this.execute(this.config.docker || 'docker',args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,
      DOCKER_HOST:this.config.dockerHost || 'unix:///var/run/docker.sock'},timeout:20000,maxBuffer:20*1024*1024,...options});
    return r.stdout;
  }
  async readFile(filename) {
    const script=String.raw`
import os,sys,stat,base64
p=os.path.realpath(sys.argv[1])
if not p.startswith('/work/'):raise ValueError('File must be inside /work')
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 info=os.fstat(fd)
 if not stat.S_ISREG(info.st_mode) or info.st_size>8*1024*1024:raise ValueError('Read requires a regular file within 8 MiB')
 if not os.path.realpath('/proc/self/fd/'+str(fd)).startswith('/work/'):raise ValueError('File escaped /work')
 with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(8*1024*1024+1)
 if len(raw)>8*1024*1024:raise ValueError('File exceeds 8 MiB')
 print(base64.b64encode(raw).decode())
finally:os.close(fd)
`;
    return Buffer.from((await this.docker(['exec',this.config.containerId,'python3','-c',script,filename])).trim(),'base64');
  }
  async validate() {
    const c=JSON.parse(await this.docker(['inspect',this.config.containerId]))[0];
    const networks=c.HostConfig.NetworkMode==='none'?[]:await Promise.all(Object.keys(c.NetworkSettings.Networks).map(async name=>JSON.parse(await this.docker(['network','inspect',name]))[0]));
    validateSandbox(c,networks,this.config);
    if(this.config.egress?.mode==='lan' && c.HostConfig.NetworkMode!=='none' && !networks.every(n=>n.Internal)) await verifyEgress(this.config,this.execute);
    await this.validateJobStorage();
  }
  async validateJobStorage() {
    if(this.jobStoragePreflight)return this.jobStoragePreflight;
    const preflight=(async()=>{
      const id=crypto.randomUUID().replaceAll('-',''),command=JOB_STORAGE_PREFLIGHT_COMMAND,encoded=Buffer.from(command,'utf8').toString('base64');
      try {
        const started=JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',START,id,encoded,'5']));
        if(started.job_id!==id)throw Error('Job storage preflight returned an unexpected job identity');
        const observed=JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',READ,id,'/work','0','0','5',hash(command)],{timeout:25000}));
        if(observed.status!=='finished'||observed.exit_code!==0||observed.stdout!==JOB_STORAGE_PREFLIGHT_OUTPUT)throw Error('Job storage preflight could not observe its command output and exit status');
      }catch(error) {
        const detail=jobStorageFailure(error);
        throw Error(detail?`Sandbox job-storage preflight failed: ${detail}`:'Sandbox job-storage preflight failed. The solver must be able to create and observe jobs under /work/.offline-jobs.');
      }
    })();
    this.jobStoragePreflight=preflight;
    try{return await preflight;}catch(error){if(this.jobStoragePreflight===preflight)this.jobStoragePreflight=undefined;throw error;}
  }
  checkCommand(command, seconds) {
    if(typeof command!=='string' || command.length>16000 || !command.trim() || !Number.isInteger(seconds) || seconds<1 || seconds>3600) throw Error('Invalid command or runtime budget');
  }
  allocateJob(callId) {
    const prior=this.store.events.find(e=>e.type==='job_allocated'&&e.data.callId===callId);
    if(prior)return prior.data;
    const used=new Set(this.store.events.filter(e=>['job_allocated','job_started'].includes(e.type)).map(e=>e.data.job_id));
    let next=1;while(used.has('j'+next))next++;
    const job={job_id:'j'+next,storage_id:hash(this.store.root+'\0'+callId).slice(0,32),callId};
    this.store.append('job_allocated',job);
    return job;
  }
  jobStorageId(id) {
    if(typeof id!=='string'||!/^(?:j[1-9][0-9]*|[a-f0-9]{32})$/.test(id))throw Error('Unknown job ID');
    const job=this.store.events.find(e=>['job_started','job_launch_attempt'].includes(e.type)&&e.data.job_id===id)?.data;
    if(!job)throw Error('Unknown job ID');
    const storageId=job.storage_id??id;
    if(!/^[a-f0-9]{32}$/.test(storageId))throw Error('Invalid retained job identity');
    return storageId;
  }
  async start(command, seconds, callId, waitSeconds=15, signal) {
    this.checkCommand(command,seconds);
    if(!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>15)throw Error('Initial wait must be 0..15 seconds');
    await this.validate();
    const job=this.allocateJob(callId),id=job.job_id;
    // Keep task command text out of launcher/supervisor argv: a task's pkill -f
    // must not match those controls merely because they transport its command.
    // Bash still receives the original bytes and retains normal signal behavior.
    const encoded=Buffer.from(command,'utf8').toString('base64');
    this.store.append('job_launch_attempt',{...job,command_hash:hash(command),seconds});
    let response;
    try{response={...JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',START,job.storage_id,encoded,String(seconds)])),job_id:id};}
    catch(error){
      const storageError=jobStorageFailure(error);
      if(storageError){
        this.store.append('job_launch_failed',{job_id:id,error_kind:'job_storage_unavailable'});
        return {job_id:id,status:'launch_failed',exit_code:null,execution_confirmed:false,error:'Job storage is unavailable; the command was not started.',note:'Repair the writable /work job storage before running another command.'};
      }
      // Observe this exact allocated job. A lost acknowledgement is never
      // permission to invoke START a second time.
      try{
        const retained=await this.read(id,waitSeconds,{},signal);
        if(retained.status==='job_missing'){
          this.store.append('job_launch_record_missing',{job_id:id,error_kind:error.name});
          return {...retained,status:'job_record_missing',execution_confirmed:false,error:'No retained job record exists after the launch acknowledgement failed.',note:'Do not keep waiting for this job; its state cannot be observed.'};
        }
        this.store.append('job_launch_ack_lost',{job_id:id,error_kind:error.name});
        this.store.append('job_launch_observed',{job_id:id,status:retained.status});
        return {...retained,launch_ack_lost:true,command_replayed:false};
      }catch(observationError){
        this.store.append('job_launch_ack_lost',{job_id:id,error_kind:error.name});
        this.store.append('job_launch_observation_failed',{job_id:id,error_kind:observationError.name});
        return {job_id:id,status:'unknown_launch',exit_code:null,execution_confirmed:false,error:'Local launch acknowledgement unavailable',note:'The command was not replayed. Observe this job with wait_job before assuming its effects.'};
      }
    }
    this.store.append('job_started',{...job,command_hash:hash(command),seconds});
    try{
      const result=await this.read(id,waitSeconds,{},signal);
      return result;
    }catch(error){
      // Launch is already durably acknowledged. A failed observation must not
      // make that command uncertain or cause it to be launched again.
      this.store.append('job_initial_wait_error',{job_id:id,error:error.message});
    }
    return {...response,status:'started',note:'Use wait_job to observe this job.'};
  }
  async read(id, waitSeconds=0, offsets={}, signal) {
    const storageId=this.jobStorageId(id);
    if(!Number.isInteger(waitSeconds) || waitSeconds<0 || waitSeconds>120) throw Error('Wait must be 0..120 seconds');
    const stdoutOffset=offsets.stdoutOffset??0,stderrOffset=offsets.stderrOffset??0;
    if(![stdoutOffset,stderrOffset].every(x=>Number.isSafeInteger(x)&&x>=0))throw Error('Invalid job output offset');
    await this.validate();
    const proof=this.store.events.find(e=>['job_started','job_launch_attempt'].includes(e.type)&&e.data.job_id===id)?.data;
    return {...JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',READ,storageId,'/work',String(stdoutOffset),String(stderrOffset),String(waitSeconds),proof?.command_hash??''],{timeout:20000+waitSeconds*1000,signal})),job_id:id};
  }
  async cancel(id) {
    const storageId=this.jobStorageId(id);
    // A firewall drift must not prevent stopping an already retained command.
    // This path starts no solver command and still pins the sandbox identity.
    const c=JSON.parse(await this.docker(['inspect',this.config.containerId]))[0];
    if(c.Id!==this.config.containerId || c.Image!==this.config.imageId || !c.State?.Running) throw Error('Sandbox identity or state changed');
    const result={...JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',CANCEL,storageId])),job_id:id};
    this.store.append('job_cancel_requested',{job_id:id,result});
    return result;
  }
  async image(filename) {
    if(typeof filename!=='string' || filename.length>500 || filename.includes('\0')) throw Error('Invalid task image path');
    await this.validate();
    const code=String.raw`
import pathlib,sys,json,base64,hashlib
from PIL import Image
p=pathlib.Path('/work')/sys.argv[1];p=p.resolve(strict=True)
assert p.is_relative_to('/work') and p.is_file() and p.stat().st_size<=8*1024*1024
with Image.open(p) as im:
 assert im.format in ('PNG','JPEG') and im.width*im.height<=16*1024*1024
 fmt=im.format;im.verify()
data=p.read_bytes()
print(json.dumps({'path':str(p),'mimeType':'image/png' if fmt=='PNG' else 'image/jpeg','sha256':hashlib.sha256(data).hexdigest(),'data':base64.b64encode(data).decode()}))
`;
    const image=JSON.parse(await this.docker(['exec',this.config.containerId,'python3','-c',code,filename]));
    if(hash(Buffer.from(image.data,'base64'))!==image.sha256) throw Error('Task image identity changed');
    return image;
  }
}
