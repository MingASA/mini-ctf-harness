import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,atomic} from '../src/store.mjs';
import {VerdictChannel} from '../src/tools.mjs';
import {reconcileSubmissionFeedback} from '../src/submission-feedback.mjs';
import {runTask} from '../src/runner.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'verdicts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const run=path.join(root,'run'),store=new Store(run),inbox=path.join(root,'verdicts');fs.mkdirSync(inbox);return {root,store,verdict:new VerdictChannel('fixture',path.join(run,'submissions'),inbox)};}
function decide(v,call,candidate,status){const pending=v.submit(call,candidate);atomic(path.join(v.inbox,pending.submission_id+'.json'),{id:pending.submission_id,candidate_sha256:pending.candidate_sha256,status});}
test('all retained calls receive identity-matched feedback once, with immutable requests and no tool replay',t=>{
 const {store,verdict}=fixture(t);
 for(const [call,candidate] of [['a','alpha'],['b','beta']]){store.append('tool_start',{callId:call,name:'submit_flag',args:{candidate}});store.append('submission',verdict.submit(call,candidate));store.append('tool_done',{callId:call,result:{}});decide(verdict,call,candidate,'incorrect');}
 const prefix=fs.readFileSync(store.file),stats=fs.readdirSync(verdict.outbox).map(n=>[n,fs.statSync(path.join(verdict.outbox,n)).mtimeMs]),saved=[];
 assert.deepEqual(reconcileSubmissionFeedback(store,verdict,'fixture',saved),{resolved:2,correct:false});assert.equal(saved.length,2);assert.deepEqual(saved.map(m=>m.harnessSubmissionCallId),['a','b']);
 assert(fs.readFileSync(store.file).subarray(0,prefix.length).equals(prefix));assert.deepEqual(fs.readdirSync(verdict.outbox).map(n=>[n,fs.statSync(path.join(verdict.outbox,n)).mtimeMs]),stats);
 const count=store.events.length;reconcileSubmissionFeedback(store,verdict,'fixture',[]);assert.equal(store.events.length,count);assert.equal(store.events.filter(e=>e.type==='tool_start').length,2);
});
test('legacy feedback is attributed and an already-resolved crash gap is delivered without resubmission',t=>{
 const {store,verdict}=fixture(t);
 for(const [call,candidate] of [['a','alpha'],['b','beta']]){store.append('tool_start',{callId:call,name:'submit_flag',args:{candidate}});const pending=verdict.submit(call,candidate);decide(verdict,call,candidate,'incorrect');store.append('submission',{...pending,status:'incorrect'});if(call==='a')store.append('message',{role:'user',harnessInboxKind:'observation',content:'Trusted judge feedback: that submitted candidate is incorrect. Revise using task evidence.'});}
 verdict.resolve=()=>{throw Error('Resolved calls must not resubmit');};const saved=[];reconcileSubmissionFeedback(store,verdict,'fixture',saved);assert.equal(saved.length,1);assert.equal(saved[0].harnessSubmissionCallId,'b');
});
for(const firstCorrect of [false,true])test('real Pi multi-submit resume resolves every call; earlier correct='+firstCorrect,async t=>{
 const {root,store,verdict}=fixture(t);let generations=0;
 const fetchFn=async(url,options)=>{
  if(!options?.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:16000}});
  const body=JSON.parse(options.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});generations++;
  let delta,finish;
  if(generations===1){delta={tool_calls:['a','b'].map((id,index)=>({index,id,function:{name:'submit_flag',arguments:JSON.stringify({candidate:id})}}))};finish='tool_calls';}
  else{const feedback=body.messages.filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('Trusted judge feedback:'));assert.equal(feedback.length,2);for(const id of ['a','b'])assert(feedback.some(m=>m.content.includes('"candidate":"'+id+'"')));delta={content:'Use both retained verdicts to revise.'};finish='stop';}
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
 };
 const task={id:'fixture',objective:'Submit two independent synthetic candidates.'},cfg={runDir:store.root,baseUrl:'http://127.0.0.1:8081',model:'fixture',contextTokens:16000,promptTokens:6500,generationTokens:1024,compactTokens:1024,reasoningTokens:512,safetyTokens:64,maxSeconds:60,maxTurns:20,maxGeneratedTokens:10000};
 const options={testMode:true,guard:()=>{},fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{}},verdict};
 assert.equal((await runTask(task,cfg,options)).status,'awaiting_judge');assert.equal(generations,1);
 const calls=new Store(store.root).events.filter(e=>e.type==='tool_start'&&e.data.name==='submit_flag');assert.equal(calls.length,2);
 for(const [i,c] of calls.entries())decide(verdict,c.data.callId,c.data.args.candidate,firstCorrect&&i===0?'correct':'incorrect');
 const result=await runTask(task,cfg,{...options,resume:true});assert.equal(result.status,firstCorrect?'correct':'model_stopped_without_verified_answer');assert.equal(generations,firstCorrect?1:2);
 const after=new Store(store.root);assert.equal(after.events.filter(e=>e.type==='tool_start'&&e.data.name==='submit_flag').length,2);assert.equal(after.events.filter(e=>e.type==='message'&&e.data.harnessSubmissionCallId).length,2);
});
