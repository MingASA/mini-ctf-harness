import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,hash} from '../src/store.mjs';
import {ContextManager,wire} from '../src/context.mjs';
import {NativeClient} from '../src/native.mjs';
import {systemPrompt} from '../src/runner.mjs';
import {skillsPrompt} from '../src/skills.mjs';
import {COMPACT_INITIAL_PROMPT,COMPACT_UPDATE_PROMPT,SOLVING_SYSTEM_PROMPT} from '../src/compact-prompts.mjs';
import {summary,envelope,controlPayload} from './compact-fixture.mjs';
const counter=async input=>Math.ceil(JSON.stringify(input).length/4);
const config={mode:'memory-skills',contextTokens:55296,promptTokens:2500,compactSoftTokens:2500,compactHardTokens:45056,generationTokens:8192,compactTokens:8192,safetyTokens:2048,compactTailGroups:1};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'prefix-v2-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.append('task',{task:{id:'synthetic-prefix',objective:'Retain measured observations'}});const sys={role:'system',content:'STABLE_SYSTEM_FIXTURE',toolsAdded:[{name:'fixture',description:'Stable definition',parameters:{type:'object',properties:{},additionalProperties:false}}]};const m=[sys,{role:'user',content:'Retain exact observed measurement and scoped failure.'}];store.append('message',m[1]);return {store,m};}
function activity(store,m,start,end){for(let i=start;i<end;i++){for(const x of [{role:'assistant',content:[{type:'thinking',thinking:('THINKING_'+i+' ').repeat(60)},{type:'toolCall',id:'c'+i,name:'fixture',arguments:{}}]},{role:'toolResult',toolName:'fixture',toolCallId:'c'+i,content:[{type:'text',text:('ORIGINAL_FULL_TOOL_'+i+' ').repeat(130)}]}]){m.push(x);store.append('message',x);}}}
function isExactPrefix(actual,expected){assert.deepEqual(actual.tools,expected.tools);assert.deepEqual(actual.messages.slice(0,-1),expected.messages.slice(0,actual.messages.length-1));}
test('current prompt files are connected and the solving system uses native skill locations',()=>{
 const root=new URL('../prompts/user-v2/',import.meta.url);
 assert.equal(COMPACT_INITIAL_PROMPT,fs.readFileSync(new URL('compact_initial.txt',root),'utf8'));assert.equal(COMPACT_UPDATE_PROMPT,fs.readFileSync(new URL('compact_update.txt',root),'utf8'));
 const docs=[{name:'exact-skill',description:'Exact descriptor',filePath:'/project/.agents/skills/exact-skill/SKILL.md'}];assert.equal(systemPrompt('memory-skills',{docs}),SOLVING_SYSTEM_PROMPT.replace('{{SKILL_CATALOG}}',skillsPrompt({docs})));
});
test('initial and update Compact preserve normal system/tools/typed history and every covered thinking/tool byte',async t=>{
 const {store,m}=fixture(t);activity(store,m,0,8);const c=new ContextManager(store,config),baseline=wire(c.assemble(m[0],m.slice(1),undefined));let first;
 await c.build(m,counter,async input=>{first=input;isExactPrefix(input,baseline);assert.deepEqual(input.messages.slice(0,-1),baseline.messages);assert.ok(controlPayload(input).retained_recent_message_indexes.length>0);assert.equal(input.messages[0].content,'STABLE_SYSTEM_FIXTURE');assert.ok(input.messages.at(-1).content.startsWith(COMPACT_INITIAL_PROMPT));assert.match(JSON.stringify(input),/THINKING_0/);assert.equal(input.tool_choice,'none');return envelope(summary('PRESERVED_EVIDENCE_ID'));});
 assert.equal(store.events.filter(e=>e.type==='compact_commit').length,1);assert.ok(JSON.stringify(first.messages).includes('ORIGINAL_FULL_TOOL_0 '.repeat(130)));assert.equal(store.events.some(e=>e.type==='artifact'&&e.data.source==='context:bounded-tool'),false);
 activity(store,m,8,16);const secondBaseline=wire(c.assemble(m[0],m.slice(1),c.checkpoint()));
 await c.build(m,counter,async input=>{isExactPrefix(input,secondBaseline);assert.deepEqual(input.messages.slice(0,-1),secondBaseline.messages);assert.ok(input.messages.at(-1).content.startsWith(COMPACT_UPDATE_PROMPT));assert.ok(controlPayload(input).previous_compact_in_prefix);assert.match(JSON.stringify(input),/PRESERVED_EVIDENCE_ID/);assert.ok(!JSON.stringify(input).includes('ORIGINAL_FULL_TOOL_0'));return envelope(summary('PRESERVED_EVIDENCE_ID'));});
 assert.equal(store.events.filter(e=>e.type==='compact_commit').length,2);assert.equal(store.events.filter(e=>e.type==='tool_start').length,0);
});
test('wire provenance does not change serialization and never labels tool images/control memory as human instructions',()=>{
 const m=[{role:'system',content:'rules'},{role:'user',content:'Real goal'},{role:'user',harnessMemory:true,content:'Prior recovery summary'},{role:'assistant',content:[{type:'toolCall',id:'i',name:'view_image',arguments:{}}]},{role:'toolResult',toolCallId:'i',content:[{type:'image',mimeType:'image/png',data:'AAAA'}]},{role:'user',harnessInboxKind:'observation',content:'Synthetic judge feedback'}];
 const {provenance,...actual}=wire(m,{includeProvenance:true});assert.deepEqual(actual,wire(m));assert.equal(provenance.length,actual.messages.length);assert.deepEqual(provenance.flatMap((p,i)=>p.kind==='human_instruction'?[i]:[]),[1]);assert.ok(provenance.some(x=>x.kind==='tool_images'));
});
test('oversized full-prefix input fails without changing any history or invoking the model',async t=>{
 const {store,m}=fixture(t);activity(store,m,0,30);const cfg={...config,contextTokens:12000,generationTokens:4096,compactTokens:4096,safetyTokens:64,promptTokens:4500,compactSoftTokens:4500,compactHardTokens:7840};const c=new ContextManager(store,cfg),baseline=wire(c.assemble(m[0],m.slice(1),undefined));
 await assert.rejects(c.build(m,counter,async()=>{throw Error('Oversized request must not generate');}),/Full-prefix Compact exceeds exact capacity/);
 assert.deepEqual(wire(c.assemble(m[0],m.slice(1),undefined)),baseline);assert.equal(c.checkpoint(),undefined);assert.equal(store.events.filter(e=>e.type==='compact_capacity_exceeded').length,1);
});
test('normal stays medium/thinking; Compact retains definitions and medium but disables thinking and tool invocation',t=>{
 const {store}=fixture(t),client=new NativeClient({model:'fixture',baseUrl:'http://127.0.0.1:8081',contextTokens:55296,generationTokens:8192,reasoningTokens:4096},store,{guard:()=>{}}),input={messages:[{role:'system',content:'Stable'},{role:'user',content:'Original'}],tools:[{type:'function',function:{name:'fixture',parameters:{type:'object'}}}]};const normal=client.body(input),compact=client.body(input,{kind:'compact',maxTokens:8192});
 assert.deepEqual(normal.chat_template_kwargs,{enable_thinking:true,reasoning_effort:'medium'});assert.deepEqual(compact.chat_template_kwargs,{enable_thinking:false,reasoning_effort:'medium'});assert.deepEqual(compact.tools,normal.tools);assert.deepEqual(compact.messages,normal.messages);assert.equal(compact.tool_choice,'none');assert.equal(compact.response_format.json_schema.strict,true);
});
