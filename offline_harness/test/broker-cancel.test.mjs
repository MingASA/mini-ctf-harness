import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DockerBroker,JOB_SCRIPTS} from '../src/broker.mjs';
const exec=promisify(execFile);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function python(code,args=[]){
 if(code===JOB_SCRIPTS.start)args=[args[0],Buffer.from(args[1],'utf8').toString('base64'),...args.slice(2)];
 return JSON.parse((await exec('python3',['-c',code,...args],{timeout:12000,maxBuffer:1024*1024})).stdout);
}
async function poll(read,predicate,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(predicate(value))return value;await sleep(40);}throw Error('Supervisor did not reach expected state');}
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-cancel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('cancel one recorded process group while another command finishes and outputs survive',{timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-cancel-')),first='a'.repeat(32),second='b'.repeat(32);
  const start=(id,command)=>python(JOB_SCRIPTS.start,[id,command,'4',dir]);
  const read=id=>python(JOB_SCRIPTS.read,[id,dir]);
  const a=await start(first,"printf 'alpha-start\n'; printf 'alpha-error\n' >&2; sleep 4; printf 'alpha-end\n'");
  await start(second,"printf 'beta-start\n'; sleep 1; printf 'beta-end\n'");
  // Jobs have their own short timeout as a fail-safe if this test assertion fails.
  t.after(async()=>{for(const id of [first,second]){try{await python(JOB_SCRIPTS.cancel,[id,dir]);await poll(()=>read(id),s=>['finished','cancelled','unknown_exit'].includes(s.status));}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
  const running=await poll(()=>read(first),s=>s.status==='running' && s.stdout.includes('alpha-start'));
  assert.notEqual(running.child.pid,a.supervisor_pid);
  assert.equal(running.child.pid,running.child.pgid);
  assert.equal(running.child.pid,running.child.session);
  assert(Number.isInteger(running.child.start_ticks));
  const requested=await python(JOB_SCRIPTS.cancel,[first,dir]);assert.equal(requested.status,'cancel_requested');assert(requested.signal_sent);
  const [cancelled,finished]=await Promise.all([poll(()=>read(first),s=>s.status==='cancelled'),poll(()=>read(second),s=>s.status==='finished')]);
  assert.match(cancelled.stdout,/alpha-start/);assert.match(cancelled.stderr,/alpha-error/);assert(!cancelled.stdout.includes('alpha-end'));
  assert.equal(finished.exit_code,0);assert.match(finished.stdout,/beta-end/);
  const again=await python(JOB_SCRIPTS.cancel,[first,dir]);assert.equal(again.status,'cancelled');assert(again.already_terminal);
});

test('durable cancellation before launch prevents the command from starting',async t=>{
  const dir=temp(t),id='c'.repeat(32),root=path.join(dir,'.offline-jobs',id);fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({status:'starting',job_id:id}));
  const requested=await python(JOB_SCRIPTS.cancel,[id,dir]);assert.equal(requested.signal_sent,false);
  const marker=JSON.parse(fs.readFileSync(path.join(root,'cancel.json')));assert.equal(marker.job_id,id);
  await exec('python3',['-c',JOB_SCRIPTS.worker,root,Buffer.from('touch must-not-launch').toString('base64'),'2',dir]);
  const result=await python(JOB_SCRIPTS.read,[id,dir]);assert.equal(result.status,'cancelled');assert.equal(result.launched,false);
  assert(!fs.existsSync(path.join(dir,'must-not-launch')));
});

test('identity validation refuses reused PID/start ticks and never signals that child',async()=>{
  const result=await python(JOB_SCRIPTS.control+String.raw`
import subprocess
p=subprocess.Popen(['sleep','3'],start_new_session=True)
try:
 record=identity(p.pid);record['start_ticks']+=1
 try:
  signal_child(record,signal.SIGTERM)
  raise AssertionError('Reused PID was accepted')
 except ValueError as error:
  assert 'identity changed' in str(error)
 assert p.poll() is None
 print(json.dumps({'refused':True,'child_alive':True}))
finally:
 os.killpg(p.pid,signal.SIGKILL);p.wait()
`);assert(result.refused && result.child_alive);
});

test('broker permits cancellation only for a job recorded in this task store',async t=>{
  const base=temp(t),workDir=path.join(base,'offline-harness','work','task');fs.mkdirSync(workDir,{recursive:true});
  const id='d'.repeat(32),other='e'.repeat(32),events=[{type:'job_started',data:{job_id:id}}],appended=[];
  let executions=0;
  const broker=new DockerBroker({workDir,containerId:'container',imageId:'image'}, {events,append:(type,data)=>appended.push({type,data})},async()=>{executions++;return {stdout:'{}'};});
  await assert.rejects(broker.cancel(other),/Unknown job/);await assert.rejects(broker.cancel('../../'),/Unknown job/);assert.equal(executions,0);
  broker.validate=async()=>{throw Error('Simulated firewall drift');};
  broker.docker=async args=>{
    if(args[0]==='inspect')return JSON.stringify([{Id:'container',Image:'image',State:{Running:true}}]);
    assert.equal(args.at(-1),id);assert.equal(args.at(-2),JOB_SCRIPTS.cancel);return JSON.stringify({job_id:id,status:'cancel_requested'});
  };
  assert.equal((await broker.cancel(id)).status,'cancel_requested');assert.equal(appended[0].type,'job_cancel_requested');
  broker.docker=async()=>JSON.stringify([{Id:'wrong-container',Image:'image',State:{Running:true}}]);
  await assert.rejects(broker.cancel(id),/identity or state/);
});

test('TERM-resistant command is escalated only within its recorded group',{timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-escalate-')),id='f'.repeat(32),read=()=>python(JOB_SCRIPTS.read,[id,dir]);
  await python(JOB_SCRIPTS.start,[id,"trap '' TERM; printf 'ready\n'; sleep 4",'4',dir]);
  t.after(async()=>{try{await python(JOB_SCRIPTS.cancel,[id,dir]);await poll(read,s=>['finished','cancelled','unknown_exit'].includes(s.status));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
  await poll(read,s=>s.status==='running' && s.stdout.includes('ready'));
  await python(JOB_SCRIPTS.cancel,[id,dir]);
  const result=await poll(read,s=>s.status==='cancelled');assert.equal(result.exit_code,-9);assert.match(result.stdout,/ready/);
});

test('runtime budget remains enforced after replacing external timeout',{timeout:10000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-timeout-')),id='1'.repeat(32),read=()=>python(JOB_SCRIPTS.read,[id,dir]);
  await python(JOB_SCRIPTS.start,[id,"printf 'bounded\n'; sleep 5",'1',dir]);
  t.after(async()=>{try{await python(JOB_SCRIPTS.cancel,[id,dir]);await poll(read,s=>['finished','cancelled','unknown_exit'].includes(s.status));}finally{fs.rmSync(dir,{recursive:true,force:true});}});
  const result=await poll(read,s=>s.status==='finished');assert.equal(result.exit_code,124);assert(result.timed_out);assert.match(result.stdout,/bounded/);
});

test('legacy running jobs without child identity reject cancellation without pretending success',async t=>{
  const dir=temp(t),id='2'.repeat(32),root=path.join(dir,'.offline-jobs',id);fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({status:'running',pid:12345}));
  await assert.rejects(python(JOB_SCRIPTS.cancel,[id,dir]),/Legacy job lacks child identity/);
  assert(!fs.existsSync(path.join(root,'cancel.json')));
});

test('task pkill pattern cannot match transported command in launcher or supervisor argv',{timeout:10000},async t=>{
 const dir=temp(t),id='7'.repeat(32),marker='job-pkill-'+path.basename(dir);
 const command=`printf 'before-kill'; sleep .3; pkill -f '${marker}'; printf 'must-not-run'`;
 const started=await python(JOB_SCRIPTS.start,[id,command,'3',dir]);
 const result=await poll(()=>python(JOB_SCRIPTS.read,[id,dir]),s=>['finished','unknown_exit'].includes(s.status));
 assert.equal(result.status,'finished');assert.equal(result.exit_code,-15);
 assert.equal(result.stdout,'before-kill');assert.equal(result.supervisor.pid,started.supervisor_pid);
 assert.equal(fs.readFileSync(path.join(dir,'.offline-jobs',id,'command.sha256'),'utf8'),(await import('../src/store.mjs')).hash(command));
});
