import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeClient} from '../src/native.mjs';
import {Store} from '../src/store.mjs';
import {auxiliarySse} from './compact-fixture.mjs';
const config={model:'fixture',baseUrl:'http://127.0.0.1:8081',contextTokens:55296,generationTokens:8192,compactTokens:8192,reasoningTokens:4096,safetyTokens:0};
const input={messages:[{role:'system',content:'Stable fixture'},{role:'user',content:'Retain synthetic observations'}],tools:[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}]};
test('Thinking uses requested1.0/.95/20 with medium reasoning',()=>{
 const client=new NativeClient(config,{}, {guard:()=>{}}),body=client.body(input);
 assert.deepEqual([body.temperature,body.top_p,body.top_k],[1.0,0.95,20]);
 assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'medium'});
});
test('Non-thinking uses requested.7/.80/20 while preserving full input and strict Compact protocol',()=>{
 const client=new NativeClient(config,{}, {guard:()=>{}}),body=client.body(input,{kind:'compact',maxTokens:8192});
 assert.deepEqual([body.temperature,body.top_p,body.top_k],[0.7,0.80,20]);
 assert.deepEqual(body.messages,input.messages);assert.deepEqual(body.tools,input.tools);
 assert.equal(body.chat_template_kwargs.enable_thinking,false);assert.equal(body.chat_template_kwargs.reasoning_effort,'medium');
 assert.equal(body.tool_choice,'none');assert.equal(body.max_tokens,8192);assert.equal(body.cache_prompt,true);
 assert.equal(body.response_format.json_schema.strict,true);
});
test('native count and actual auxiliary HTTP request carry the same Non-thinking sampling',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sampling-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),sent=[];
 const fetchFn=async(url,options)=>{const body=JSON.parse(options.body);sent.push({url,body});return url.endsWith('input_tokens')?Response.json({input_tokens:100}):new Response(auxiliarySse(100,200));};
 const client=new NativeClient(config,store,{guard:()=>{},fetchFn});
 await client.complete(input,{kind:'compact',maxTokens:8192});assert.equal(sent.length,2);
 for(const {body} of sent){assert.deepEqual([body.temperature,body.top_p,body.top_k],[0.7,0.80,20]);assert.equal(body.chat_template_kwargs.enable_thinking,false);assert.equal(body.max_tokens,8192);}
 const {stream,stream_options,...generation}=sent[1].body;assert.deepEqual(generation,sent[0].body);
 assert.equal(store.events.filter(e=>e.type==='model_request').length,1);assert.equal(store.events.filter(e=>e.type==='tool_start').length,0);
});
