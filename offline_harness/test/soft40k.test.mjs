import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {ContextManager,wire} from '../src/context.mjs';
import {envelope} from './compact-fixture.mjs';
const cfg={mode:'memory',contextTokens:55296,promptTokens:40960,compactSoftTokens:40960,compactHardTokens:null,generationTokens:8192,compactTokens:8192,safetyTokens:2048,compactTailGroups:1};
// A deterministic unit counter; native tokenizer coverage is a separate probe.
const count=async input=>Math.ceil(JSON.stringify(input).length/4);
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'soft40k-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const s=new Store(root);s.append('task',{task:{id:'capacity',objective:'Preserve synthetic measurements'}});const messages=[{role:'system',content:'Stable rules'},{role:'user',content:'Synthetic capacity measurement'}];s.append('message',messages[1]);const add=chars=>{for(const m of [{role:'assistant',content:[{type:'toolCall',id:'call-'+messages.length,name:'measure',arguments:{}}]},{role:'toolResult',toolCallId:'call-'+messages.length,content:[{type:'text',text:'m'.repeat(chars)}]}]){messages.push(m);s.append('message',m);}};return {s,messages,add};}
test('soft40K is fixed; the deprecated hard value cannot cap generation',async t=>{
 const {s,messages,add}=fixture(t);add(145000);const c=new ContextManager(s,{...cfg,compactHardTokens:45056});let calls=0;
 const built=await c.build(messages,count,async()=>{calls++;return envelope();});
 assert.equal(c.limits().soft,40960);assert.equal(calls,0);assert.ok(built.maxTokens<8192);
 const event=s.events.findLast(e=>e.type==='context_budget').data;
 assert.equal(event.hard_limit,null);assert.equal(event.soft_limit,40960);
 assert.equal(built.maxTokens,Math.min(8192,55296-8192-2048-event.compact_input_tokens-256));
});
test('40K crossing compacts the complete prefix, including unread tool results',async t=>{
 const {s,messages,add}=fixture(t);add(166000);add(128);const c=new ContextManager(s,cfg),before=wire(c.assemble(messages[0],messages.slice(1),undefined));let calls=0;
 await c.build(messages,count,async input=>{calls++;assert.deepEqual(input.messages.slice(0,-1),before.messages);assert.deepEqual(input.tools,before.tools);assert.ok((await count(input))+8192+2048<=55296);return envelope();});
 assert.equal(calls,1);assert.equal(c.checkpoint().cut,3); // Last unread pair remains in recovery tail.
});
test('a tool-result capacity overrun is explicit and never trims an earlier prefix',async t=>{
 const {s,messages,add}=fixture(t);add(185000);const c=new ContextManager(s,cfg);let calls=0;
 await assert.rejects(c.build(messages,count,async()=>{calls++;return envelope();}),/no history trimmed/);
 assert.equal(calls,0);assert.equal(s.events.filter(e=>e.type==='message').length,3);assert.equal(s.events.filter(e=>e.type==='compact_commit').length,0);
 assert.equal(s.events.findLast(e=>e.type==='compact_capacity_exceeded').data.history_retained,true);
});
test('zero safety reserve admits the retained45646-token envelope with full8K output',async t=>{
 const {s,messages,add}=fixture(t);add(128);add(128);
 const c=new ContextManager(s,{...cfg,safetyTokens:0}),prefix=wire(c.assemble(messages[0],messages.slice(1),undefined));let calls=0;
 const counter=async(input,options)=>options?.kind==='compact'?45646:input.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Recovery view;'))?1000:41000;
 await c.build(messages,counter,async(input,options)=>{
  calls++;assert.equal(options.maxTokens,8192);assert.deepEqual(input.messages.slice(0,-1),prefix.messages);assert.deepEqual(input.tools,prefix.tools);return envelope();
 });
 assert.equal(calls,1);assert.equal(c.limits().margin,0);
 assert.equal(s.events.findLast(e=>e.type==='compact_commit').data.input_tokens,45646);
 assert.equal(s.events.findLast(e=>e.type==='context_budget').data.safety_tokens,0);
 assert.equal(55296-45646-8192,1458);
});
test('zero reserve still rejects a full-prefix envelope exceeding the physical window',async t=>{
 const {s,messages,add}=fixture(t);add(128);add(128);const c=new ContextManager(s,{...cfg,safetyTokens:0});let calls=0;
 const counter=async(input,options)=>options?.kind==='compact'?47105:41000;
 await assert.rejects(c.build(messages,counter,async()=>{calls++;return envelope();}),/no history trimmed/);
 assert.equal(calls,0);assert.equal(c.checkpoint(),undefined);
 assert.equal(s.events.findLast(e=>e.type==='compact_capacity_exceeded').data.safety_tokens,0);
});
