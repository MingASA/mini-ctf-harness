import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DockerBroker,JOB_SCRIPTS} from '../src/broker.mjs';
import {Store} from '../src/store.mjs';
import {buildTools} from '../src/tools.mjs';
import {InteractiveSession} from '../src/interactive-session.mjs';
const exec=promisify(execFile);
const observation=result=>JSON.parse(result.content[0].text);

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'command-wait-')),work=path.join(root,'offline-harness/work/task');
 fs.mkdirSync(work,{recursive:true});
 const store=new Store(path.join(root,'run'));let launches=0;
 // Execute the production Python launcher/reader, substituting only Docker's
 // transport and /work. No model service or real Docker container is needed.
 const execute=async(binary,args,options)=>{
  assert.equal(binary,'docker');
  if(args[0]==='inspect')return {stdout:JSON.stringify([{Id:'synthetic',Image:'fixture-image',State:{Running:true}}])};
  const at=args.indexOf('python3'),script=args[at+2],parameters=args.slice(at+3);
  assert.ok(at>0);assert.ok([JOB_SCRIPTS.start,JOB_SCRIPTS.read,JOB_SCRIPTS.cancel].includes(script));
  if(script===JOB_SCRIPTS.start){launches++;parameters.push(work);}
  else if(script===JOB_SCRIPTS.read){assert.equal(parameters[1],'/work');parameters[1]=work;}
  else parameters.push(work);
  return exec('python3',['-c',script,...parameters],{timeout:options.timeout,maxBuffer:options.maxBuffer});
 };
 const broker=new DockerBroker({workDir:work,containerId:'synthetic',imageId:'fixture-image'},store,execute);
 broker.validate=async()=>{};
 t.after(async()=>{
  for(const {data} of new Store(store.root).events.filter(e=>e.type==='job_started')){
   try{
    const storageId=data.storage_id??data.job_id;
    await exec('python3',['-c',JOB_SCRIPTS.cancel,storageId,work],{timeout:5000});
    await exec('python3',['-c',JOB_SCRIPTS.read,storageId,work,'0','0','4'],{timeout:5000});
   }catch{}
  }
  fs.rmSync(root,{recursive:true,force:true});
 });
 return {root,work,store,broker,get launches(){return launches;}};
}

function sandboxFixture(t,{startError}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'command-preflight-')),work=path.join(root,'offline-harness/work/task');
 fs.mkdirSync(work,{recursive:true});const store=new Store(path.join(root,'run'));let starts=0;
 const container={Id:'synthetic',Image:'fixture-image',State:{Running:true},HostConfig:{Privileged:false,PidMode:'',IpcMode:'',NetworkMode:'none',CapAdd:[],Devices:[],DeviceRequests:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Memory:2048*1024*1024,PidsLimit:128,ReadonlyRootfs:true,PortBindings:{}},Mounts:[{Destination:'/work',Source:work,Type:'bind'}],NetworkSettings:{Networks:{}}};
 const execute=async(binary,args,options)=>{
  assert.equal(binary,'docker');
  if(args[0]==='inspect')return {stdout:JSON.stringify([container])};
  const at=args.indexOf('python3'),script=args[at+2],parameters=args.slice(at+3);
  assert.ok(at>0);assert.ok([JOB_SCRIPTS.start,JOB_SCRIPTS.read,JOB_SCRIPTS.cancel].includes(script));
  if(script===JOB_SCRIPTS.start){starts++;const error=startError?.();if(error)throw error;parameters.push(work);}
  else if(script===JOB_SCRIPTS.read){assert.equal(parameters[1],'/work');parameters[1]=work;}
  else parameters.push(work);
  return exec('python3',['-c',script,...parameters],{timeout:options.timeout,maxBuffer:options.maxBuffer});
 };
 const broker=new DockerBroker({workDir:work,containerId:'synthetic',imageId:'fixture-image'},store,execute);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,work,store,broker,get starts(){return starts;}};
}

test('sandbox validation performs one retained-job preflight before model work begins',async t=>{
 const f=sandboxFixture(t);
 await f.broker.validate();
 assert.equal(f.starts,1);
 assert.equal(f.store.events.length,0);
 assert.ok(fs.existsSync(path.join(f.work,'.offline-jobs')));
 await f.broker.validate();
 assert.equal(f.starts,1);
});

test('sandbox validation rejects unavailable job storage and allows a later retry',async t=>{
 let fail=true;
 const f=sandboxFixture(t,{startError:()=>{
  if(!fail)return undefined;
  const error=Error('synthetic docker failure');error.stderr='RuntimeError: Job storage unavailable: [Errno 13] Permission denied';return error;
 }});
 await assert.rejects(f.broker.validate(),/Sandbox job-storage preflight failed: \[Errno 13\] Permission denied/);
 assert.equal(f.store.events.length,0);
 fail=false;
 await f.broker.validate();
 assert.equal(f.starts,2);
});

test('run_command returns a quick command result immediately with stdout, stderr and nonzero exit code',async t=>{
 const f=fixture(t),tool=buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command');
 const args={command:"printf 'quick中文'; printf 'diagnostic' >&2; exit 7"};
 const before=performance.now(),result=await tool.execute('quick',args),data=observation(result);
 assert.ok(performance.now()-before<5000);
 assert.equal(data.status,'finished');assert.equal(data.exit_code,7);
 assert.equal(data.job_id,'j1');
 assert.equal(data.stdout,'quick中文');assert.equal(data.stderr,'diagnostic');
 assert.equal(result.details.job_status,'finished');assert.equal(f.launches,1);
 const cursor=f.store.events.findLast(e=>e.type==='job_output_cursor').data;
 assert.equal(cursor.stdout_offset,Buffer.byteLength('quick中文'));assert.equal(cursor.stderr_offset,10);
 // Replayed calls return the same retained result after restart.
 const restarted=new Store(f.store.root),tools=buildTools(restarted,f.broker,{},{});
 assert.deepEqual(await tools.find(t=>t.name==='run_command').execute('quick',args),result);
 assert.equal(f.launches,1);assert.equal(restarted.events.filter(e=>e.type==='job_output_cursor').length,1);
 const tail=observation(await tools.find(t=>t.name==='wait_job').execute('reread',{job_id:data.job_id}));
 assert.equal(tail.stdout,'');assert.equal(tail.stderr,undefined);assert.equal(tail.exit_code,7);
});

test('a command still running at 15 seconds returns the original async response and the same job continues',{timeout:30000},async t=>{
 const f=fixture(t),before=performance.now();
 const started=await f.broker.start("printf 'before\\n'; sleep 16; printf 'after\\n'",25,'long');
 const elapsed=performance.now()-before;
 assert.ok(elapsed>=14900,elapsed);assert.ok(elapsed<18000,elapsed);
 assert.equal(started.status,'running');
 assert.ok(started.job_id);assert.equal(started.stdout,'before\n');assert.equal(f.launches,1);
 const finished=await f.broker.read(started.job_id,5);
 assert.equal(finished.status,'finished');assert.equal(finished.exit_code,0);
 assert.equal(finished.stdout,'before\nafter\n');assert.equal(f.launches,1);
});

test('the initial wait remains 15 seconds independently of command timeout and respects remaining solve time',async t=>{
 const f=fixture(t),seen=[];
 const broker={start:async(...args)=>{seen.push(args);return {job_id:'a'.repeat(32),status:'started'};}};
 const call={command:'printf fixture'};
 await buildTools(f.store,broker,{},{}).find(t=>t.name==='run_command').execute('default',call);
 assert.equal(seen[0][1],3600);assert.equal(seen[0][3],15);
 await buildTools(f.store,broker,{}, {},()=>{},{remainingMs:()=>2300}).find(t=>t.name==='run_command').execute('budget',call);
 assert.equal(seen[1][3],2);
 const before=performance.now(),started=await f.broker.start("sleep .3; printf 'done'",3,'no-budget-wait',0);
 assert.equal(started.status,'running');
 assert.ok(performance.now()-before<2000);
 assert.equal((await f.broker.read(started.job_id,2)).stdout,'done');
});

test('the bounded reader returns a dead worker as unknown_exit without waiting 15 seconds',async t=>{
 const f=fixture(t),id='f'.repeat(32),root=path.join(f.work,'.offline-jobs',id);fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({status:'running',supervisor:{pid:2147483647}}));
 f.store.append('job_started',{job_id:id});
 const before=performance.now(),result=await f.broker.read(id,15);
 assert.equal(result.status,'unknown_exit');assert.ok(performance.now()-before<2000);
});

test('an initial read failure preserves the acknowledged async job and never relaunches the command',async t=>{
 const f=fixture(t),read=f.broker.read.bind(f.broker);
 f.broker.read=async()=>{throw Error('Synthetic observer unavailable');};
 const tools=buildTools(f.store,f.broker,{},{}),result=observation(await tools.find(t=>t.name==='run_command').execute('read-fault',{command:"printf 'retained job'"}));
 assert.equal(result.status,'running');assert.equal(f.launches,1);assert.equal(f.store.pending().length,0);
 assert.equal(f.store.events.findLast(e=>e.type==='job_initial_wait_error').data.job_id,result.job_id);
 f.broker.read=read;
 const finished=observation(await tools.find(t=>t.name==='wait_job').execute('collect-retained',{job_id:result.job_id}));
 assert.equal(finished.status,'finished');assert.equal(finished.stdout,'retained job');assert.equal(f.launches,1);
});

test('lost launch acknowledgement observes the same real job and never invokes START twice',async t=>{
 const f=fixture(t),execute=f.broker.execute;let injected=false;
 f.broker.execute=async(binary,args,options)=>{const result=await execute(binary,args,options);if(args.includes(JOB_SCRIPTS.start)&&!injected){injected=true;throw Error('Synthetic acknowledgement lost after execution');}return result;};
 const tool=buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command');
 const result=observation(await tool.execute('lost-ack',{command:'printf x >> executions.txt; cat executions.txt'}));
 assert.equal(result.stdout,'x');assert.ok(f.store.events.some(e=>e.type==='job_launch_ack_lost'));assert.equal(f.store.events.filter(e=>e.type==='job_launch_attempt').length,1);assert.equal(f.launches,1);assert.equal(f.store.pending().length,0);
 assert.equal((await f.broker.read(result.job_id)).stdout,'x');
});

test('a known job-storage launcher failure says that the command did not start',async t=>{
 const f=fixture(t),execute=f.broker.execute;
 f.broker.execute=async(binary,args,options)=>{
  if(args.includes(JOB_SCRIPTS.start)){const error=Error('synthetic storage failure');error.stderr='RuntimeError: Job storage unavailable: [Errno 13] Permission denied';throw error;}
  return execute(binary,args,options);
 };
 const tool=buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command');
 const result=observation(await tool.execute('storage-failure',{command:'printf forbidden'}));
 assert.equal(result.status,'launch_failed');assert.match(result.message,/did not start/);assert.equal(result.job_id,'j1');assert.equal(f.launches,0);
 assert.ok(f.store.events.some(e=>e.type==='job_launch_failed'));
 assert.ok(!f.store.events.some(e=>e.type==='job_launch_ack_lost'));
});

test('terminal launch failures do not create an interactive wait dependency',async t=>{
 const f=fixture(t),broker={validate:async()=>{},start:async()=>({job_id:'j1',status:'launch_failed',error:'Job storage is unavailable'})};
 const session=new InteractiveSession({id:'storage-failure',objective:'Exercise a failed launcher.'},{runDir:f.store.root,baseUrl:'http://127.0.0.1:8081'},{store:f.store,broker,knowledge:{docs:[]},guard:()=>{}});
 const result=observation(await session.tools().find(t=>t.name==='run_command').execute('launch-failure',{command:'printf forbidden'}));
 assert.equal(result.status,'launch_failed');assert.deepEqual(session.dependencies(),[]);
});

test('a missing retained record is distinct from a lost launch acknowledgement',async t=>{
 const f=fixture(t),execute=f.broker.execute;
 f.broker.execute=async(binary,args,options)=>{if(args.includes(JOB_SCRIPTS.start))throw Error('Synthetic transport unavailable before execution');return execute(binary,args,options);};
 const tool=buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command');
 const result=observation(await tool.execute('no-ack',{command:'printf forbidden'}));
 assert.equal(result.status,'job_record_missing');assert.match(result.message,/Do not keep waiting/);assert.equal(result.job_id,'j1');assert.equal(f.launches,0);assert.equal(f.store.pending().length,0);
 assert.ok(f.store.events.some(e=>e.type==='job_launch_record_missing'));
 assert.ok(!f.store.events.some(e=>e.type==='job_launch_ack_lost'));
 const replay=observation(await tool.execute('no-ack',{command:'printf forbidden'}));assert.deepEqual(replay,result);assert.equal(f.launches,0);
});

test('transport loss with no observable job record remains an uncertain launch',async t=>{
 const f=fixture(t),execute=f.broker.execute;
 f.broker.execute=async(binary,args,options)=>{
  if(args.includes(JOB_SCRIPTS.start))throw Error('Synthetic launch transport unavailable');
  if(args.includes(JOB_SCRIPTS.read))throw Error('Synthetic observation transport unavailable');
  return execute(binary,args,options);
 };
 const result=observation(await buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command').execute('transport-failure',{command:'printf forbidden'}));
 assert.equal(result.status,'unknown_launch');assert.match(result.message,/uncertain/);assert.equal(f.launches,0);
 assert.ok(f.store.events.some(e=>e.type==='job_launch_ack_lost'));
 assert.ok(f.store.events.some(e=>e.type==='job_launch_observation_failed'));
});

test('wait_job returns a terminal record-missing result instead of a FileNotFoundError loop',async t=>{
 const f=fixture(t),storage='a'.repeat(32);
 f.store.append('job_launch_attempt',{job_id:'j1',storage_id:storage,callId:'missing',command_hash:'b'.repeat(64),seconds:1});
 const result=observation(await buildTools(f.store,f.broker,{},{}).find(t=>t.name==='wait_job').execute('wait-missing',{job_id:'j1'}));
 assert.equal(result.status,'job_missing');assert.match(result.message,/Do not keep waiting/);assert.equal(result.job_id,'j1');
});

test('identical commands execute again with j1, j2 and a stable j3 after restart, without new evidence',async t=>{
 const f=fixture(t),args={command:'printf x >> executions.txt; cat executions.txt'};
 const run=buildTools(f.store,f.broker,{},{}).find(t=>t.name==='run_command');
 const first=observation(await run.execute('repeat-1',args)),second=observation(await run.execute('repeat-2',args));
 assert.equal(first.job_id,'j1');assert.equal(second.job_id,'j2');
 assert.equal(first.stdout,'x');assert.equal(second.stdout,'xx');assert.equal(f.launches,2);
 const store=new Store(f.store.root),broker=new DockerBroker(f.broker.config,store,f.broker.execute);broker.validate=async()=>{};
 const resumed=buildTools(store,broker,{},{}).find(t=>t.name==='run_command');
 const replay=await resumed.execute('repeat-2',args);assert.equal(observation(replay).job_id,'j2');assert.equal(f.launches,2);
 const third=observation(await resumed.execute('repeat-3',args));assert.equal(third.job_id,'j3');assert.equal(third.stdout,'xxx');assert.equal(f.launches,3);
 assert.equal((await broker.read('j1')).stdout,'x');assert.equal((await broker.read('j2')).stdout,'xx');
});

test('short job reservations survive restart and reserve IDs even before a launch',async t=>{
 const f=fixture(t),first=f.broker.allocateJob('reserved-before-launch');assert.equal(first.job_id,'j1');
 const store=new Store(f.store.root),broker=new DockerBroker(f.broker.config,store,f.broker.execute);
 assert.deepEqual(broker.allocateJob('reserved-before-launch'),first);
 assert.equal(broker.allocateJob('another-call').job_id,'j2');
 assert.equal(store.events.filter(e=>e.type==='job_allocated').length,2);
 await assert.rejects(broker.read('j1'),/Unknown job ID/);
});

test('short job IDs cancel the original recorded process and reject unknown IDs',async t=>{
 const f=fixture(t),job=await f.broker.start("printf 'ready'; sleep 4; printf 'must-not-finish'",8,'cancel-short',0);
 assert.equal(job.job_id,'j1');
 const cancelled=await f.broker.cancel('j1');assert.equal(cancelled.job_id,'j1');assert.equal(cancelled.status,'cancel_requested');
 const result=await f.broker.read('j1',4);assert.equal(result.status,'cancelled');assert.ok(!result.stdout.includes('must-not-finish'));
 assert.equal((await f.broker.cancel('j1')).already_terminal,true);
 await assert.rejects(f.broker.cancel('j2'),/Unknown job ID/);
 await assert.rejects(f.broker.read('../j1'),/Unknown job ID/);
 const entry=f.store.events.find(e=>e.type==='job_started').data;
 assert.match(entry.storage_id,/^[a-f0-9]{32}$/);
 assert.equal(f.store.events.findLast(e=>e.type==='job_cancel_requested').data.job_id,'j1');
});

test('job IDs remain task local when two tasks each have j1',async t=>{
 const a=fixture(t),b=fixture(t);
 const first=await a.broker.start('printf first',5,'same-call-id'),second=await b.broker.start('printf second',5,'same-call-id');
 assert.equal(first.job_id,'j1');assert.equal(second.job_id,'j1');
 assert.equal((await a.broker.read('j1')).stdout,'first');assert.equal((await b.broker.read('j1')).stdout,'second');
 assert.notEqual(a.store.events.find(e=>e.type==='job_started').data.storage_id,b.store.events.find(e=>e.type==='job_started').data.storage_id);
});

test('a real Pi interactive loop consumes the inline command result without wait_job or a waiting dependency',async t=>{
 const f=fixture(t);let generations=0;
 const fetchFn=async(url,options={})=>{
  if(!options.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:16000}});
  const body=JSON.parse(options.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  generations++;let delta;
  if(generations===1)delta={tool_calls:[{index:0,id:'command',function:{name:'run_command',arguments:JSON.stringify({command:"printf 'inline-result'"})}}]};
  else {
   const result=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
   assert.equal(result.status,'finished');assert.equal(result.stdout,'inline-result');assert.equal(result.exit_code,0);
   delta={content:'The command result is available.'};
  }
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:generations===1?'tool_calls':'stop'}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020}})+'\n\ndata: [DONE]\n\n');
 };
 const config={runDir:f.store.root,baseUrl:'http://127.0.0.1:8081',contextTokens:16000,promptTokens:7000,generationTokens:1024,reasoningTokens:256,maxSeconds:60};
 const session=new InteractiveSession({id:'inline',objective:'Read the synthetic command output.'},config,{store:f.store,broker:f.broker,knowledge:{docs:[]},guard:()=>{},fetchFn});
 const result=await session.runSlice();
 assert.equal(result.status,'awaiting_input',JSON.stringify(result));assert.deepEqual(result.dependencies,[]);
 assert.equal(generations,2);assert.equal(f.launches,1);
 assert.equal(f.store.events.filter(e=>e.type==='dependency_started').length,0);
 assert.equal(f.store.events.filter(e=>e.type==='tool_start'&&e.data.name==='wait_job').length,0);
 assert.equal(f.store.pending().length,0);
});
