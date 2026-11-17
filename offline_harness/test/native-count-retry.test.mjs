import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeClient} from '../src/native.mjs';
import {Store} from '../src/store.mjs';
import {runTask} from '../src/runner.mjs';
const cfg={mode:'memory',model:'fixture',baseUrl:'http://127.0.0.1:8081',contextTokens:12000,promptTokens:4000,generationTokens:2048,compactTokens:1024,reasoningTokens:512,safetyTokens:64,maxSeconds:60,maxTurns:10};
const input={messages:[{role:'user',content:'Synthetic transport measurement.'}],tools:[]};
const failure=(code='UND_ERR_CONNECT_TIMEOUT')=>new TypeError('fetch failed',{cause:Object.assign(new Error('Synthetic transport failure'),{code})});
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'count-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const metadata=url=>Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:cfg.contextTokens}});
const sse=(delta,finish)=>new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:1000,completion_tokens:50,total_tokens:1050}})+'\n\ndata: [DONE]\n\n');
test('actual Pi loop retries only one failed count and never repeats a completed tool or generation',async t=>{
 const root=temporary(t);let counts=0,generations=0,commands=0;const bodies=[];
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return metadata(url);
  if(url.endsWith('input_tokens')){counts++;bodies.push(opt.body);if(counts===2)throw failure();return Response.json({input_tokens:1000});}
  generations++;
  return generations===1?sse({tool_calls:[{index:0,id:'measure',function:{name:'run_command',arguments:JSON.stringify({command:'printf synthetic'})}}]},'tool_calls'):sse({content:'Synthetic transport fixture complete.'},'stop');
 };
 const result=await runTask({id:'count-retry',objective:'Verify synthetic transport continuity.'},{...cfg,runDir:root},{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{},start:async()=>{commands++;return {job_id:'a'.repeat(32),status:'started'};}}});
 // Each turn counts its normal input and the full Compact capacity envelope.
 assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));assert.equal(generations,2);assert.equal(commands,1);assert.equal(counts,5);assert.equal(bodies[1],bodies[2]);
 const s=new Store(root);assert.equal(s.events.filter(e=>e.type==='model_request').length,2);assert.equal(s.events.filter(e=>e.type==='model_response').length,2);assert.equal(s.events.filter(e=>e.type==='tool_start').length,1);assert.equal(s.events.filter(e=>e.type==='tool_done').length,1);assert.equal(s.pending().length,0);
 assert.deepEqual(s.events.filter(e=>e.type==='native_metadata_retry').map(e=>e.data),[{route:'/v1/chat/completions/input_tokens',attempt:2,cause_code:'UND_ERR_CONNECT_TIMEOUT',delay_ms:100}]);
});
test('persistent count connection timeout is bounded to two attempts and preserves its cause',async t=>{
 const s=new Store(temporary(t)),errors=[failure(),failure()];let calls=0;
 const c=new NativeClient(cfg,s,{guard:()=>{},fetchFn:async()=>{throw errors[calls++];}});
 await assert.rejects(c.count(input),e=>e===errors[1]);assert.equal(calls,2);assert.equal(s.events.filter(e=>e.type==='native_metadata_retry').length,1);assert.equal(s.events.filter(e=>e.type==='model_request').length,0);
});
test('HTTP, parsing and other transport failures are not retried',async t=>{
 for(const kind of ['ECONNREFUSED','UND_ERR_HEADERS_TIMEOUT','http','json']){
  const s=new Store(temporary(t));let calls=0;
  const c=new NativeClient(cfg,s,{guard:()=>{},fetchFn:async()=>{calls++;if(kind==='http')return new Response('',{status:500});if(kind==='json')return new Response('invalid JSON');throw failure(kind);}});
  await assert.rejects(c.count(input));assert.equal(calls,1);assert.equal(s.events.filter(e=>e.type==='native_metadata_retry').length,0);
 }
});
test('Compact generation connection timeout is never automatically retried',async t=>{
 const s=new Store(temporary(t));let counts=0,generations=0;const error=failure();
 const c=new NativeClient(cfg,s,{guard:()=>{},fetchFn:async url=>{if(url.endsWith('input_tokens')){counts++;return Response.json({input_tokens:1000});}generations++;throw error;}});
 await assert.rejects(c.complete(input,{kind:'compact',maxTokens:1024}),e=>e===error);assert.equal(counts,1);assert.equal(generations,1);assert.equal(s.events.filter(e=>e.type==='model_request').length,1);assert.equal(s.events.filter(e=>e.type==='model_accepted'||e.type==='native_metadata_retry').length,0);
});
test('ordinary generation connection timeout still stops the real Pi loop without a retry',async t=>{
 const root=temporary(t);let generations=0,counts=0;
 const fetchFn=async(url,opt)=>{if(!opt?.body)return metadata(url);if(url.endsWith('input_tokens')){counts++;return Response.json({input_tokens:1000});}generations++;throw failure();};
 const result=await runTask({id:'generation-failure',objective:'Synthetic no-replay fixture.'},{...cfg,runDir:root},{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{}}});
 assert.equal(result.status,'needs_review');assert.equal(counts,2);assert.equal(generations,1);
 const s=new Store(root);assert.equal(s.events.filter(e=>e.type==='model_request').length,1);assert.equal(s.events.filter(e=>e.type==='model_error').at(-1).data.cause_code,'UND_ERR_CONNECT_TIMEOUT');assert.equal(s.events.filter(e=>['model_accepted','native_metadata_retry','tool_start'].includes(e.type)).length,0);
});
test('task abort during count retry delay prevents a second attempt',async t=>{
 const s=new Store(temporary(t)),abort=new AbortController();let calls=0;
 const c=new NativeClient(cfg,s,{guard:()=>{},fetchFn:async()=>{calls++;setTimeout(()=>abort.abort(),5);throw failure();}});
 await assert.rejects(c.count(input,abort.signal),/abort/i);assert.equal(calls,1);assert.equal(s.events.filter(e=>e.type==='model_request').length,0);
});
