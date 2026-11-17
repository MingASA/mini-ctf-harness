import {auxiliarySse} from './compact-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {runTask as runHarnessTask} from '../src/runner.mjs';
import {Store} from '../src/store.mjs';
import {VerdictChannel} from '../src/tools.mjs';
import {grade} from '../src/judge.mjs';

// Protocol fixtures reserve space for the full supplied system/Compact footer.
// Installed catalog/transport behavior is exercised in installed-skills.test.mjs.
const runTask=(task,config,options)=>runHarnessTask(task,config,{knowledge:{docs:[]},...options});

const tokenCount=body=>Math.ceil(JSON.stringify({messages:body.messages,tools:body.tools}).length/4);
async function provider(script) {
  const requests=[];let turn=0;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method==='GET') {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/slots'?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:16000}}));return;
      }
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);requests.push({route:req.url,body});
      if(req.url.endsWith('/input_tokens')) {res.setHeader('content-type','application/json');res.end(JSON.stringify({input_tokens:tokenCount(body)}));return;}
      if(body.response_format?.json_schema?.name==='compact_checkpoint'){assert.equal(body.stream,true);res.setHeader('content-type','text/event-stream');res.end(auxiliarySse(tokenCount(body)));return;}
      const output=await script(++turn,body);
      res.setHeader('content-type','text/event-stream');
      const delta={reasoning_content:'Consider a discriminating check. '.repeat(70)};
      if(output.tool)delta.tool_calls=[{index:0,id:output.callId||'call-'+turn,type:'function',function:{name:output.tool,arguments:JSON.stringify(output.args)}}];
      else delta.content=output.text || 'finished';
      const finish=output.finish || (output.tool?'tool_calls':'stop');
      const frame='data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:output.noUsage?undefined:{prompt_tokens:tokenCount(body),completion_tokens:300,total_tokens:tokenCount(body)+300}})+'\n\n';
      // Exercise split UTF-8/JSON lines, not only one-buffer responses.
      res.write(frame.slice(0,19));res.write(frame.slice(19));if(!output.missingDone)res.write('data: [DONE]\n\n');res.end();
    } catch(e) {res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {origin:`http://127.0.0.1:${server.address().port}`,requests,close:()=>new Promise(resolve=>server.close(resolve))};
}
const cfg=(root,origin)=>({runDir:path.join(root,'run'),baseUrl:origin,contextTokens:16000,promptTokens:6500,compactTokens:1024,generationTokens:1024,reasoningTokens:512,maxTurns:150,maxGeneratedTokens:100000,maxSeconds:60});
const fakeBroker={validate:async()=>{},readFile:async()=>Buffer.from('Synthetic reference: measured route=cyan-7'),start:async()=>({job_id:'a'.repeat(32),status:'started'}),
 read:async()=>({job_id:'a'.repeat(32),status:'finished',exit_code:0,stdout:'measured route=cyan-7',stderr:''})};

test('real Pi loop survives repeated context rebuilds and retrieves old evidence without judge leakage',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-offline-'));let observation,step=0;
 fs.writeFileSync(path.join(root,'private-answers.json'),'PRIVATE_JUDGE_CANARY');
 const p=await provider((_turn,body)=>{
   assert.ok(!JSON.stringify(body).includes('PRIVATE_JUDGE_CANARY'));

   const turn=++step;
   if(turn===1)return {tool:'run_command',args:{command:'printf fixture'}};
   if(turn===2)return {tool:'wait_job',args:{job_id:'a'.repeat(32)}};
   if(turn===3){observation='/work/measurement.txt';return {tool:'read',args:{path:observation}};}
   if(turn<24)return {tool:'wait_job',args:{job_id:'a'.repeat(32)}};
   if(turn===24)return {tool:'read',args:{path:'/work/reference.md'}};
   if(turn===25)return {tool:'read',args:{path:'/work/reference.md'}};
   if(turn===26)return {tool:'read',args:{path:observation}};
   if(turn===27)return {tool:'read',args:{path:observation}};
   assert.ok(JSON.stringify(body.messages).includes('cyan-7'));
   return {tool:'submit_flag',args:{candidate:'cyan-7'}};
 });
 try {
   const result=await runTask({id:'synthetic-memory',objective:'Recover a measured route after unrelated experiments.'},cfg(root,p.origin),
     {guard:()=>{},broker:fakeBroker,knowledge:{docs:[{name:'evidence-ledger',description:'Synthetic reference',filePath:'/work/reference.md'}],read:()=>({text:'Synthetic reference: keep measurement identifiers.'})},verdict:{submit:(_id,candidate)=>({status:candidate==='cyan-7'?'correct':'incorrect'})},testMode:true});
   assert.equal(result.status,'correct',JSON.stringify(result));assert.ok(result.turns>=28);assert.equal(step,28);
   const s=new Store(path.join(root,'run'));
   const compacts=s.events.filter(e=>e.type==='compact_commit').length;assert.ok(compacts>0);
   assert.equal(s.events.filter(e=>e.type==='model_request'&&e.data.kind==='compact').length,compacts);
   assert.equal(s.events.filter(e=>e.type==='model_request'&&e.data.kind==='reconcile').length,0);
   assert.ok(s.events.filter(e=>e.type==='context_budget' && e.data.removed_groups>0).length>10);
   assert.equal(s.events.filter(e=>e.type==='tool_start' && e.data.name==='run_command').length,1);
   assert.ok(s.events.some(e=>e.type==='tool_start'&&e.data.name==='read'&&e.data.args.path===observation));
   // Token-count probes may inspect an overfull candidate; generation may not.
   for(const request of p.requests.filter(r=>r.route==='/v1/chat/completions'))assert.ok(tokenCount(request.body)<=(request.body.response_format?16000-1024-2048:6500));
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('length or interrupted SSE never executes even syntactically complete partial tools',async()=>{
 for(const fault of ['length','missingDone','noUsage']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-fault-'));let commands=0;
  const p=await provider(()=>({tool:'run_command',args:{command:'printf should-not-execute'},finish:fault==='length'?'length':undefined,missingDone:fault==='missingDone',noUsage:fault==='noUsage'}));
  try {
    const config={...cfg(root,p.origin),maxTurns:1};
    const result=await runTask({id:'incomplete',objective:'Protocol fixture'},config,{guard:()=>{},testMode:true,
      broker:{...fakeBroker,start:async()=>{commands++;return {}; }},verdict:{submit:()=>({status:'pending'})}});
    assert.equal(commands,0);assert.equal(result.status,fault==='length'?'budget_exhausted':'needs_review');
    assert.equal(result.generated_tokens,fault==='noUsage'?1024:300);assert.equal(result.turns,1);
    const requests=p.requests.length;
    await assert.rejects(runTask({id:'incomplete',objective:'Protocol fixture'},config,{guard:()=>{},testMode:true,resume:true,
      broker:fakeBroker,verdict:{submit:()=>({status:'pending'})}}),/budget exhausted/);
    assert.equal(p.requests.length,requests);
    assert.ok(fs.existsSync(path.join(root,'run','request-1.sse')));
  } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('context pressure uses one combined compact request before committing a recovery checkpoint',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-checkpoint-'));let observation;
 const p=await provider((turn,body)=>{
   if(turn===1)return {tool:'run_command',args:{command:'printf fixture'}};
   if(turn===2)return {tool:'wait_job',args:{job_id:'a'.repeat(32)}};
   if(turn===3)observation='/work/measurement.txt';

   if(turn<18)return {tool:'wait_job',args:{job_id:'a'.repeat(32)}};
   return {tool:'submit_flag',args:{candidate:'cyan-7'}};
 });
 try {
  const result=await runTask({id:'checkpoint',objective:'Retain old measurements.'},cfg(root,p.origin),{guard:()=>{},broker:fakeBroker,verdict:{submit:()=>({status:'correct'})},testMode:true});
  assert.equal(result.status,'correct',JSON.stringify(result));
  const s=new Store(path.join(root,'run'));assert.ok(s.events.filter(e=>e.type==='compact_commit').length>=2);
  assert.ok(s.events.some(e=>e.type==='context_budget' && e.data.removed_groups>0));
  for(const r of p.requests.filter(r=>r.route==='/v1/chat/completions'))assert.ok(tokenCount(r.body)<=16000-1024-64);
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('pending external judge resumes with incorrect feedback without replaying a command',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-judge-'));const inbox=path.join(root,'private-inbox');fs.mkdirSync(inbox);
 const outbox=path.join(root,'run','submissions'),answers=path.join(root,'private-answers.json');
 fs.writeFileSync(answers,JSON.stringify({judge:{value:'PRIVATE_GOLD_CANARY',policy:'exact'}}));
 const p=await provider((turn,body)=>{
   assert.ok(!JSON.stringify(body).includes('PRIVATE_GOLD_CANARY'));
   return turn===1?{tool:'submit_flag',args:{candidate:'wrong-candidate'}}:{text:'I must revise my approach.'};
 });
 try {
  const config={...cfg(root,p.origin),verdictInbox:inbox};
  const task={id:'judge',objective:'Find a candidate from supplied observations.'};
  const first=await runTask(task,config,{guard:()=>{},broker:fakeBroker,testMode:true});assert.equal(first.status,'awaiting_judge');
  grade(outbox,inbox,answers);
  const second=await runTask(task,config,{guard:()=>{},broker:fakeBroker,testMode:true,resume:true});
  assert.equal(second.status,'model_stopped_without_verified_answer');
  assert.ok(p.requests.some(r=>JSON.stringify(r.body).includes('Trusted judge feedback')));
  assert.equal(new Store(path.join(root,'run')).events.filter(e=>e.type==='tool_start' && e.data.name==='submit_flag').length,1);
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('comparison arms expose only their enabled context tools and instructions',async()=>{
 for(const mode of ['baseline','memory']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-arm-'));
  const p=await provider((_turn,body)=>{
    const names=body.tools.map(t=>t.function.name),system=body.messages[0].content;
    assert.ok(!names.some(n=>n==='Skill'||n.startsWith('skill_')));assert.ok(!system.includes('<available_skills>'));assert.ok(!system.includes('Use Skill '));
    assert.ok(names.includes('read'));assert.ok(!names.some(n=>n.endsWith('_work_state')));assert.ok(!system.includes('Work State'));
    return {text:'No verified answer in this protocol fixture.'};
  });
  try {
    const result=await runTask({id:'arm',objective:'Protocol fixture'}, {...cfg(root,p.origin),mode},
      {guard:()=>{},broker:fakeBroker,verdict:{submit:()=>({status:'pending'})},testMode:true});
    assert.equal(result.status,'model_stopped_without_verified_answer');
  } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('correct external verdict is consumed at exhausted generation budget without a new model call',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-final-judge-')),inbox=path.join(root,'inbox');
 fs.mkdirSync(inbox);
 const answers=path.join(root,'private-answers.json');
 fs.writeFileSync(answers,JSON.stringify({final:{value:'derived-fixture-value',policy:'exact'}}));
 const p=await provider(()=>({tool:'submit_flag',args:{candidate:'derived-fixture-value'}}));
 try {
  const task={id:'final',objective:'Submit the synthetic value.'};
  const config={...cfg(root,p.origin),verdictInbox:inbox,maxTurns:1,maxGeneratedTokens:300};
  const options={guard:()=>{},broker:fakeBroker,testMode:true};
  const first=await runTask(task,config,options);assert.equal(first.status,'awaiting_judge');
  grade(path.join(root,'run','submissions'),inbox,answers);
  const count=p.requests.length;
  const second=await runTask(task,config,{...options,resume:true});
  assert.equal(second.status,'correct');assert.equal(second.generated_tokens,300);
  assert.equal(p.requests.length,count);
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('native tool numbering may restart per response without replaying another call',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-call-ids-'));
 const p=await provider(turn=>turn<=2?{tool:'read',callId:'call_0',args:{path:'/work/next-action-'+turn+'.txt'}}:{text:'Protocol fixture done.'});
 try {
  const result=await runTask({id:'numbering',objective:'Protocol fixture'},cfg(root,p.origin),
    {guard:()=>{},broker:fakeBroker,verdict:{submit:()=>({status:'pending'})},testMode:true});
  assert.equal(result.status,'model_stopped_without_verified_answer');
  const s=new Store(path.join(root,'run'));
  assert.equal(s.events.filter(e=>e.type==='tool_start').at(-1).data.args.path,'/work/next-action-2.txt');assert.equal(s.pending().length,0);
  assert.equal(new Set(s.events.filter(e=>e.type==='tool_start').map(e=>e.data.callId)).size,2);
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('one-second wall deadline survives resume whether preflight or inference consumes it',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-deadline-'));
 const p=await provider(async()=>{await new Promise(resolve=>setTimeout(resolve,1400));return {text:'too late'};});
 try {
  const task={id:'deadline',objective:'Protocol fixture'},config={...cfg(root,p.origin),maxSeconds:1};
  const options={guard:()=>{},broker:fakeBroker,verdict:{submit:()=>({status:'pending'})},testMode:true};
  let result,preflightError;
  try {result=await runTask(task,config,options);}catch(error){preflightError=error;}
  const journal=new Store(config.runDir),requests=journal.events.filter(e=>e.type==='model_request');
  // Slow startup is a valid budget stop too. Preserve the one-second production
  // limit rather than assuming the first request always fits into that window.
  if(preflightError){assert.match(preflightError.message,/Run wall-time budget exhausted/);assert.equal(requests.length,0);}
  else {assert.equal(result.status,'wall_time_exhausted');assert.equal(result.generated_tokens,requests.length*1024);assert.ok(requests.length<=1);}
  assert.equal(journal.events.filter(e=>e.type==='model_response').length,0);
  const count=p.requests.length;
  await assert.rejects(runTask(task,config,{...options,resume:true}),/wall-time budget exhausted/);
  assert.equal(p.requests.length,count);
 } finally {await p.close();fs.rmSync(root,{recursive:true,force:true});}
});
