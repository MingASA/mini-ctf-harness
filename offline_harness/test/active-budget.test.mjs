import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {taskClock,beginSolve,endSolve,checkpointSolve,activeBudgetView,budgetPath,readSolveBudget} from '../src/task-clock.mjs';
const config={maxSeconds:10,budgetMode:'active_solve'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'active-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new Store(root);}
test('preparation, manual repair, idle and wall clock changes do not consume solve time',t=>{
 const s=fixture(t);taskClock(s,config,{start:true,startedUnix:1});
 assert.equal(taskClock(s,config,{now:864000000}).millisecondsRemaining,10000);
 const interval=beginSolve(s,config),first=taskClock(s,config,{monotonicMs:interval.data.started_monotonic_ms+2000,now:1e12});
 assert.equal(first.elapsedSolveMs,2000);assert.equal(first.millisecondsRemaining,8000);
 endSolve(s,config,interval,'manual_repair');const closed=taskClock(s,config);
 assert.equal(taskClock(s,config,{now:1e15}).millisecondsRemaining,closed.millisecondsRemaining);
 assert.equal(taskClock(new Store(s.root),config,{now:1e15}).millisecondsRemaining,closed.millisecondsRemaining);
});
test('tools and compact are part of the same active interval and resumes never reset budget',t=>{
 const s=fixture(t);taskClock(s,config,{start:true});const a=beginSolve(s,config);
 s.append('tool_start',{callId:'a',name:'wait_job'});s.append('compact_start',{});
 const current=taskClock(s,config,{monotonicMs:a.data.started_monotonic_ms+3000});assert.equal(current.millisecondsRemaining,7000);
 checkpointSolve(s,config,a);const snap=JSON.parse(fs.readFileSync(budgetPath(s),'utf8'));
 assert.equal(activeBudgetView(snap,{monotonicMs:a.data.started_monotonic_ms+3000}).remaining_ms,7000);
 endSolve(s,config,a);const consumed=taskClock(s,config).elapsedSolveMs;
 const b=beginSolve(s,config);assert.equal(b.data.used_before_segment_ms,consumed);
 assert.equal(taskClock(s,config,{monotonicMs:b.data.started_monotonic_ms+1000}).elapsedSolveMs,consumed+1000);endSolve(s,config,b);
});
test('dead worker cannot keep charging hours or reclaim consumed budget on restart',async t=>{
 const s=fixture(t),module=new URL('../src/task-clock.mjs',import.meta.url).href,storeModule=new URL('../src/store.mjs',import.meta.url).href;
 const source=`import {Store} from ${JSON.stringify(storeModule)};import {taskClock,beginSolve} from ${JSON.stringify(module)};const s=new Store(process.argv[1]),c={maxSeconds:10,budgetMode:'active_solve'};taskClock(s,c,{start:true});beginSolve(s,c);console.log('READY');setInterval(()=>{},10000);`;
 const p=spawn(process.execPath,['--input-type=module','-e',source,s.root],{stdio:['ignore','pipe','ignore']});t.after(()=>{try{p.kill('SIGKILL');}catch{}});await once(p.stdout,'data');p.kill('SIGKILL');await once(p,'exit');
 const recovered=new Store(s.root),before=taskClock(recovered,config,{now:1e15});assert.ok(before.elapsedSolveMs>=1000&&before.elapsedSolveMs<2000);assert.ok(before.millisecondsRemaining<10000);
 const resumed=beginSolve(recovered,config);assert.equal(resumed.data.used_before_segment_ms,before.elapsedSolveMs);assert.ok(taskClock(recovered,config).millisecondsRemaining<=before.millisecondsRemaining);endSolve(recovered,config,resumed);
});
test('changed budget is rejected and active exhaustion is independent of historical wall deadline',t=>{
 const s=fixture(t);taskClock(s,config,{start:true,startedUnix:1,deadlineUnix:2});const e=beginSolve(s,config);
 assert.throws(()=>taskClock(s,{...config,maxSeconds:11}),/budget changed/);
 assert.equal(taskClock(s,config,{monotonicMs:e.data.started_monotonic_ms+10001,now:1e15}).millisecondsRemaining,0);endSolve(s,config,e);
});
test('real Pi runner excludes long preparation and charges inference plus tool wait',async t=>{
 const {runTask}=await import('../src/runner.mjs');const store=fixture(t);let generation=0,seconds;
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const fetchFn=async(url,options={})=>{
  if(!options.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:65536}});
  const body=JSON.parse(options.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});
  await pause(100);generation++;
  const spec=generation===1?{name:'run_command',arguments:{command:'printf integration-fixture'}}:generation===2?{name:'wait_job',arguments:{job_id:'a'.repeat(32)}}:null;
  const delta=spec?{tool_calls:[{index:0,id:'call'+generation,function:{name:spec.name,arguments:JSON.stringify(spec.arguments)}}]}:{content:'Timing fixture complete.'};
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:spec?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
 };
 const result=await runTask({id:'fixture',objective:'Measure synthetic harness phase timing.'},{runDir:store.root,baseUrl:'http://127.0.0.1:8081',contextTokens:65536,promptTokens:51200,generationTokens:1024,reasoningTokens:256,maxSeconds:3,budgetMode:'active_solve'},
 {testMode:true,guard:()=>{},fetchFn,broker:{validate:async()=>pause(3500),start:async(_cmd,bounded)=>{seconds=bounded;return {job_id:'a'.repeat(32),status:'started'};},read:async()=>{await pause(350);return {status:'finished',exit_code:0};}}});
 assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));assert.equal(result.budget_scope,'active_solve');assert.equal(result.active_wall_ms,result.solve_elapsed_ms);assert.equal(result.maintenance_wall_ms,Math.max(0,result.wall_elapsed_ms-result.solve_elapsed_ms));assert.ok(result.wall_elapsed_ms>4000);assert.ok(result.solve_elapsed_ms>=600&&result.solve_elapsed_ms<3000);assert.equal(generation,3);assert.ok(seconds>=1&&seconds<=3);
});
test('insufficient command time leaves no uncertain tool-start receipt',async t=>{
 const {buildTools}=await import('../src/tools.mjs');const s=fixture(t);let calls=0;
 const command=buildTools(s,{start:async()=>{calls++;}},{},{},()=>{},{remainingMs:()=>500}).find(x=>x.name==='run_command');
 await assert.rejects(command.execute('too-late',{command:'printf fixture'}),/Solve time budget exhausted/);assert.equal(calls,0);assert.equal(s.pending().length,0);assert.equal(s.events.filter(e=>e.type==='tool_start').length,0);
});
test('watchdog retries rename gaps and never treats corrupt or lost checkpoints as zero use',t=>{
 const s=fixture(t);taskClock(s,config,{start:true});const event=beginSolve(s,config),file=budgetPath(s),original=fs.readFileSync;
 let misses=2;
 fs.readFileSync=function(p,...args){if(p===file&&misses-->0)throw Object.assign(Error('synthetic rename gap'),{code:'ENOENT'});return original.call(this,p,...args);};
 try{assert.equal(readSolveBudget(file).segment_seq,event.seq);assert.equal(misses,-1);}
 finally{fs.readFileSync=original;}
 endSolve(s,config,event);fs.writeFileSync(file,'invalid JSON');assert.throws(()=>readSolveBudget(file,{allowMissing:true}),SyntaxError);
 fs.unlinkSync(file);assert.throws(()=>readSolveBudget(file),{code:'ENOENT'});assert.equal(readSolveBudget(file,{allowMissing:true}),null);
});
test('resuming a killed Pi worker preserves solve usage but reports incomplete processing diagnostics',async t=>{
 const s=fixture(t),runner=new URL('../src/runner.mjs',import.meta.url).href;
 const task={id:'crash-fixture',objective:'Synthetic interrupted request.'},cfg={runDir:s.root,baseUrl:'http://127.0.0.1:8081',contextTokens:65536,promptTokens:51200,generationTokens:1024,reasoningTokens:256,maxSeconds:10,budgetMode:'active_solve'};
 const source=`import {runTask} from ${JSON.stringify(runner)};const [task,cfg]=process.argv.slice(1).map(JSON.parse);await runTask(task,cfg,{testMode:true,guard:()=>{},broker:{validate:async()=>{}},fetchFn:async(url,opt={})=>{if(!opt.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:65536}});if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});console.log('READY');return new Promise(()=>{});}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,JSON.stringify(task),JSON.stringify(cfg)],{stdio:['ignore','pipe','pipe']});t.after(()=>{try{child.kill('SIGKILL');}catch{}});
 await once(child.stdout,'data');child.kill('SIGKILL');await once(child,'exit');
 const fetchFn=async(url,opt={})=>{
  if(!opt.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:65536}});
  if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Synthetic recovery complete.'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+'\n\ndata: [DONE]\n\n');
 };
 const {runTask}=await import('../src/runner.mjs');const result=await runTask(task,cfg,{resume:true,testMode:true,guard:()=>{},broker:{validate:async()=>{}},fetchFn});
 assert.equal(result.status,'model_stopped_without_verified_answer');assert.equal(result.processing_wall_ms,null);assert.equal(result.processing_wall_complete,false);
 assert.ok(result.solve_elapsed_ms>=1000&&result.solve_elapsed_ms<10000);assert.equal(result.active_wall_ms,result.solve_elapsed_ms);
});
