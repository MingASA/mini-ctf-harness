import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runTask} from '../src/runner.mjs';
import {Store,hash} from '../src/store.mjs';
import {outputLimitContinuation} from '../src/truncation.mjs';
import {InteractiveSession} from '../src/interactive-session.mjs';

const cfg=root=>({runDir:root,mode:'memory',model:'fixture',baseUrl:'http://127.0.0.1:8081',contextTokens:12000,promptTokens:5000,compactSoftTokens:5000,compactHardTokens:null,compactTokens:1024,generationTokens:2048,reasoningTokens:-1,reasoningEffort:'xhigh',safetyTokens:64,maxSeconds:60,maxTurns:20});
const temp=t=>{const r=fs.mkdtempSync(path.join(os.tmpdir(),'output-limit-'));t.after(()=>fs.rmSync(r,{recursive:true,force:true}));return r;};
const metadata=url=>Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:12000}});
const sse=(delta,finish,output=20)=>new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:1000,completion_tokens:output,total_tokens:1000+output}})+'\n\ndata: [DONE]\n\n');
const command={tool_calls:[{index:0,id:'measure',function:{name:'run_command',arguments:JSON.stringify({command:'printf synthetic'})}}]};

for(const kind of ['thinking','text'])test(`actual Pi continues complete tool-free ${kind} at output limit without forcing Compact or replaying a tool`,async t=>{
 const root=temp(t);let generations=0,commands=0;
 const retained='Synthetic unfinished '+kind;
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return metadata(url);
  const b=JSON.parse(opt.body);
  if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  assert.equal(b.reasoning_budget_tokens,-1);assert.equal(b.max_tokens,2048);
  assert.deepEqual(b.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'xhigh'});
  assert.equal(b.response_format,undefined,'An output limit below the soft line must not force Compact');
  generations++;
  if(generations===1)return sse(kind==='thinking'?{reasoning_content:retained}:{content:retained},'length',2048);
  if(generations===2){
   assert.equal(b.messages.at(-1).role,'user');assert.match(b.messages.at(-1).content,/per-call output limit/);
   assert.ok(b.messages.some(m=>m.role==='assistant'&&m[kind==='thinking'?'reasoning_content':'content']===retained));
   return sse(command,'tool_calls');
  }
  return sse({content:'Synthetic continuation complete'},'stop');
 };
 const result=await runTask({id:'output-'+kind,objective:'Preserve a synthetic interrupted thought.'},cfg(root),{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{},start:async()=>{commands++;return {job_id:'a'.repeat(32),status:'started'};}}});
 assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));assert.equal(generations,3);assert.equal(commands,1);
 const s=new Store(root),observations=s.events.filter(e=>e.type==='message'&&e.data.harnessOutputContinuationFor!==undefined);
 assert.equal(observations.length,1);assert.equal(observations[0].data.harnessInboxKind,'observation');
 assert.equal(s.events.filter(e=>e.type==='model_output_truncated').length,1);assert.equal(s.events.filter(e=>e.type==='compact_commit'||e.type==='model_error').length,0);
 assert.equal(s.events.filter(e=>e.type==='tool_done').length,1);assert.equal(s.pending().length,0);
 assert.equal(s.events.filter(e=>e.type==='model_usage').reduce((n,e)=>n+e.data.completion_tokens,0),2088);
});

for(const args of ['{"command":',JSON.stringify({command:'printf forbidden'})])test('output length discards every old tool draft then executes only a fresh complete call: '+args.length,async t=>{
 const root=temp(t);let generations=0,commands=0;
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return metadata(url);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  generations++;
  if(generations===1)return sse({reasoning_content:'Partial tool response',tool_calls:[{index:0,id:'partial',function:{name:'run_command',arguments:args}}]},'length',2048);
  const body=JSON.parse(opt.body);assert(!body.messages.some(m=>m.tool_calls?.some(c=>c.id.includes('partial'))));
  assert.ok(body.messages.some(m=>m.reasoning_content==='Partial tool response'));assert.match(body.messages.find(m=>m.harnessOutputContinuationFor)?.content??body.messages.filter(m=>m.role==='user').at(-1).content,/No tool calls were executed/);
  return generations===2?sse(command,'tool_calls'):sse({content:'Fresh call complete'},'stop');
 };
 const result=await runTask({id:'partial-'+args.length,objective:'Check safe truncation.'},cfg(root),{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{},start:async command=>{assert.equal(command,'printf synthetic');commands++;return {job_id:'a'.repeat(32),status:'finished',exit_code:0};}}});
 assert.equal(result.status,'model_stopped_without_verified_answer');assert.equal(generations,3);assert.equal(commands,1);
 const s=new Store(root);assert.equal(s.events.filter(e=>e.type==='model_output_truncated').length,1);assert.equal(s.events.filter(e=>e.type==='model_tool_drafts_discarded').length,1);assert.equal(s.events.filter(e=>e.type==='tool_start').length,1);assert.equal(s.pending().length,0);assert.equal(s.events.filter(e=>e.type==='model_error').length,0);
});

test('resume retains output-limit reasoning and one continuation observation across a later transport failure',async t=>{
 const root=temp(t),task={id:'output-resume',objective:'Continue a synthetic measurement.'};let generations=0,commands=0;
 const options={guard:()=>{},testMode:true,knowledge:{docs:[]},broker:{validate:async()=>{},start:async()=>{commands++;return {job_id:'b'.repeat(32),status:'started'};}},fetchFn:async(url,opt)=>{
  if(!opt?.body)return metadata(url);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});generations++;
  if(generations===1)return sse({reasoning_content:'Retain this exact synthetic thought'},'length',2048);
  if(generations===2)return new Response('',{status:500});
  const b=JSON.parse(opt.body);assert.ok(b.messages.some(m=>m.reasoning_content==='Retain this exact synthetic thought'));
  return generations===3?sse(command,'tool_calls'):sse({content:'Synthetic restart finished'},'stop');
 }};
 assert.equal((await runTask(task,cfg(root),options)).status,'needs_review');const prefix=fs.readFileSync(new Store(root).file);
 const result=await runTask(task,cfg(root),{...options,resume:true});assert.equal(result.status,'model_stopped_without_verified_answer');assert.equal(generations,4);assert.equal(commands,1);
 const s=new Store(root);assert.deepEqual(fs.readFileSync(s.file).subarray(0,prefix.length),prefix);assert.equal(s.events.filter(e=>e.type==='message'&&e.data.harnessOutputContinuationFor!==undefined).length,1);assert.equal(s.events.filter(e=>e.type==='tool_done').length,1);
});

test('tool-only output truncation gets an explicit non-execution observation and continues',async t=>{
 const root=temp(t);let generations=0,commands=0;
 const fetchFn=async(url,opt)=>{if(!opt?.body)return metadata(url);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});generations++;
  if(generations===1)return sse(command,'length',2048);
  const b=JSON.parse(opt.body);assert.ok(b.messages.some(m=>m.role==='assistant'&&m.content.includes('No tool calls were executed')));return sse({content:'Continue with a new plan'},'stop');};
 const result=await runTask({id:'tool-only',objective:'Never execute a truncated response.'},cfg(root),{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{},start:async()=>commands++}});
 assert.equal(result.status,'model_stopped_without_verified_answer');assert.equal(generations,2);assert.equal(commands,0);
});

test('only a matching durable native proof can authorize output continuation including a crash before follow-up',t=>{
 const s=new Store(temp(t)),m={role:'assistant',stopReason:'stop',harnessOutputTruncated:true,content:[{type:'thinking',thinking:'Durable synthetic reasoning'}]};
 s.append('model_output_truncated',{requestId:1,reason:'generation_output_limit',content_sha256:hash(JSON.stringify(m.content))});s.append('message',m);
 const next=outputLimitContinuation(s,m);assert.equal(next.harnessOutputContinuationFor,1);assert.equal(next.harnessInboxKind,'observation');
 assert.throws(()=>outputLimitContinuation(s,{...m,content:[{type:'thinking',thinking:'Changed'}]}),/Missing native/);
 assert.throws(()=>outputLimitContinuation(s,{...m,content:[{type:'toolCall'}]}),/tool-free/);
});

test('interactive Pi loop also continues tool-free output truncation before waiting for operator input',async t=>{
 const root=temp(t);let generations=0;
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return metadata(url);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  generations++;const b=JSON.parse(opt.body);assert.equal(b.reasoning_budget_tokens,-1);
  if(generations===1)return sse({reasoning_content:'Interactive unfinished synthetic thought'},'length',2048);
  assert.match(b.messages.at(-1).content,/per-call output limit/);return sse({content:'Ready for operator'},'stop');
 };
 const session=new InteractiveSession({id:'interactive-output',objective:'Preserve synthetic reasoning.'},cfg(root),{guard:()=>{},fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{}}});
 assert.equal((await session.runSlice()).status,'awaiting_input');assert.equal(generations,2);
 assert.equal(session.store.events.filter(e=>e.type==='message'&&e.data.harnessOutputContinuationFor!==undefined).length,1);
 assert.equal(session.store.events.filter(e=>e.type==='compact_commit'||e.type==='model_error').length,0);
});
