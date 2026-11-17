import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeClient} from '../src/native.mjs';
import {runTask} from '../src/runner.mjs';
import {Store} from '../src/store.mjs';
import {envelope} from './compact-fixture.mjs';
const cfg={model:'fixture',baseUrl:'http://127.0.0.1:8081',contextTokens:55296,promptTokens:40960,compactSoftTokens:40960,compactHardTokens:null,generationTokens:8192,compactTokens:8192,reasoningTokens:-1,reasoningEffort:'xhigh',compactThinking:true,compactReasoningEffort:'xhigh',compactReasoningTokens:4096,safetyTokens:0,maxSeconds:60,maxTurns:20,maxGeneratedTokens:100000};
const input={messages:[{role:'system',content:'Stable synthetic system'},{role:'user',content:'Retain observations'}],tools:[]};
test('next-round solving has no independent thought cap; Compact retains4K within the8K total',()=>{
 const c=new NativeClient(cfg,{}, {guard:()=>{}}),normal=c.body(input),compact=c.body(input,{kind:'compact',maxTokens:8192});
 assert.equal(normal.reasoning_budget_tokens,-1);assert.equal(normal.max_tokens,8192);
 assert.equal(compact.reasoning_budget_tokens,4096);assert.equal(compact.max_tokens,8192);
 for(const b of [normal,compact]){assert.deepEqual(b.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'xhigh'});assert.deepEqual([b.temperature,b.top_p,b.top_k],[1,.95,20]);}
 assert.deepEqual(compact.messages,normal.messages);assert.deepEqual(compact.tools,normal.tools);
 const non=new NativeClient({...cfg,compactThinking:false},{},{guard:()=>{}}).body(input,{kind:'compact'});assert.deepEqual([non.temperature,non.top_p,non.top_k],[.7,.8,20]);
});
test('thinking Compact accepts separate reasoning delta and closed JSON without returning reasoning as state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thinking-compact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),sent=[];
 const fetchFn=async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);return url.endsWith('input_tokens')?Response.json({input_tokens:100}):new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Check synthetic state consistency.',content:envelope()},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:200}})+'\n\ndata: [DONE]\n\n');};
 const client=new NativeClient(cfg,store,{guard:()=>{},fetchFn});assert.equal(await client.complete(input,{kind:'compact'}),envelope());
 assert(sent.every(b=>b.reasoning_budget_tokens===4096&&b.chat_template_kwargs.reasoning_effort==='xhigh'));
 assert(store.events.find(e=>e.type==='model_auxiliary_response').data.reasoning_chars>0);
});
test('actual Pi runner preserves the unlimited reasoning sentinel and native xhigh settings',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhigh-runner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let generations=0;
 const fetchFn=async(url,options)=>{if(!options?.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:55296}});const body=JSON.parse(options.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});generations++;assert.equal(body.reasoning_budget_tokens,-1);assert.equal(body.chat_template_kwargs.reasoning_effort,'xhigh');return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Synthetic completion'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');};
 const r=await runTask({id:'xhigh-fixture',objective:'Exercise the explicit next-round configuration.'},{...cfg,runDir:dir},{testMode:true,guard:()=>{},fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{}}});assert.equal(r.status,'model_stopped_without_verified_answer');assert.equal(generations,1);
});
