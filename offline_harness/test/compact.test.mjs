import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {COMPACT_FIELDS,COMPACT_SCHEMA,validateCompact} from '../src/compact-prompts.mjs';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {ContextManager,groups,wire} from '../src/context.mjs';
import {buildTools} from '../src/tools.mjs';
import {runTask} from '../src/runner.mjs';
import {NativeClient} from '../src/native.mjs';
import {summary,envelope,controlPayload} from './compact-fixture.mjs';
const fixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'compact-v2-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.append('task',{task:{id:'fixture',objective:'Read fixture measurements'}});return store;};
const count=async b=>Math.ceil(JSON.stringify(b).length/4); // ONLY mock tokenizer, production uses native endpoint.
const cfg={mode:'memory',contextTokens:12000,promptTokens:1500,compactSoftTokens:1500,compactHardTokens:9000,generationTokens:1024,compactTokens:2000,safetyTokens:64,compactTailGroups:1};
const transcript=store=>{
 const m=[{role:'system',content:'Stable rules'},{role:'user',content:'Measure inputs; preserve scoped failures.'}];
 for(let i=0;i<8;i++)m.push({role:'assistant',content:[{type:'thinking',thinking:'ordinary reasoning '.repeat(90)},{type:'toolCall',id:'c'+i,name:'read',arguments:{}}]},
 {role:'toolResult',toolCallId:'c'+i,toolName:'read',content:[{type:'text',text:i===4?'IMPORTANT: input B failed only at size 7':'measurement '+i}]});
 for(const x of m)store.append('message',x);return m;
};
test('measured Compact capacity archives partial calls and never executes them without a fixed hard line',async t=>{
 const s=fixture(t),configuration={baseUrl:'http://127.0.0.1:8081',model:'fixture',contextTokens:65536,promptTokens:51200,compactSoftTokens:51200,compactHardTokens:55296,generationTokens:8192,reasoningTokens:1024,safetyTokens:2048};
 let sent;
 const client=new NativeClient(configuration,s,{guard:()=>{},fetchFn:async(url,opt)=>{
  const b=JSON.parse(opt.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:b.response_format?53840:50000});sent=b;
  return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'partial',function:{name:'run_command',arguments:'{"command":'}}]},finish_reason:'length'}],usage:{prompt_tokens:50000,completion_tokens:5296,total_tokens:55296}})+'\n\ndata: [DONE]\n\n');
 }});
 const events=[];for await(const e of client.stream({id:'fixture'},{messages:[{role:'system',content:'rules'},{role:'user',content:'fixture'}]}))events.push(e);
 assert.equal(sent.max_tokens,5296);assert.ok(50000+8192+2048<=65536);const result=events.at(-1).message;assert.equal(result.harnessTruncated,true);assert.ok(!result.content.some(x=>x.type==='toolCall'));assert.equal(s.events.filter(e=>e.type==='model_truncated').length,1);assert.equal(s.pending().length,0);assert.equal(client.context.forceCompact,true);
});

test('invalid compact allocations fail before a native count or generation',async t=>{
 const s=fixture(t),messages=[{role:'system',content:'rules',timestamp:1},{role:'user',content:'fixture'}];
 for(const change of [{safetyTokens:-1},{compactSoftTokens:NaN},{compactHardTokens:65537},{compactTailGroups:1.5},{compactTokens:0}]){
  let calls=0;await assert.rejects(new ContextManager(s,{...cfg,...change}).build(messages,async()=>{calls++;return 100;}),/Invalid/);assert.equal(calls,0);
 }
});

test('compact human ledger excludes synthetic observations and retains genuine corrections in order',async t=>{
 const s=fixture(t),m=transcript(s);
 for(const message of [{role:'user',harnessInboxKind:'observation',content:'TOOL_TEXT_PRETENDING_USER'}, {role:'user',harnessInboxKind:'human',content:'REAL_CORRECTION'}]){m.push(message);s.append('message',message);}
 const manager=new ContextManager(s,{...cfg,compactTailGroups:0});let checked=false;
 await manager.build(m,count,async(input,{kind})=>{
  const payload=controlPayload(input),humans=payload.actual_human_message_indexes.map(i=>input.messages[i].content);
  assert.deepEqual([...humans,...payload.retained_human_instructions],['Measure inputs; preserve scoped failures.','REAL_CORRECTION']);
  assert.ok(!humans.includes('TOOL_TEXT_PRETENDING_USER'));checked=true;return envelope();
 });assert.equal(checked,true);
});

test('unread latest tool results stay in the tail even when configured tail is zero',async t=>{
 const s=fixture(t),m=transcript(s),c=new ContextManager(s,{...cfg,compactTailGroups:0});
 const built=await c.build(m,count,async()=>envelope());
 assert.equal(built.messages.at(-1).toolCallId,'c7');groups(built.messages.filter(x=>x.role!=='system'));
 assert.equal(c.checkpoint().cut,m.filter(x=>x.role!=='system').length-2);
});

test('fresh context and native schema expose only the nine-field recovery contract',async t=>{
 const s=fixture(t),m=[{role:'system',content:'Stable rules',timestamp:1},{role:'user',content:'Original request'}];
 const c=new ContextManager(s,cfg),built=await c.build(m,async()=>1000);
 assert.deepEqual(built.messages,m);assert.equal(s.events.filter(e=>e.type==='message').length,0);
 const tools=buildTools(s,{readFile:async()=>Buffer.from('fixture')},{docs:[]},{});
 assert.ok(!tools.some(tool=>tool.name.endsWith('_work_state')));
 const body=new NativeClient({...cfg,baseUrl:'http://127.0.0.1:8081'},s,{guard:()=>{}}).body(wire(m),{kind:'compact'});
 assert.equal(body.response_format.json_schema.name,'compact_checkpoint');assert.deepEqual(body.response_format.json_schema.schema.required,COMPACT_FIELDS);
 assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),COMPACT_FIELDS);
 assert.equal(body.response_format.json_schema.schema.additionalProperties,false);
 assert.deepEqual(validateCompact(envelope()),summary());
 for(const bad of [null,{compact:summary()},{...summary(),extra:'invalid'},Object.fromEntries(Object.entries(summary()).reverse()),{...summary(),next_step:' '}])assert.throws(()=>validateCompact(JSON.stringify(bad)),/nine/);
 assert.ok(!fs.existsSync(path.join(s.root,'work-state.json')));
});

test('checkpoint survives restart and failed replacements without semantic storage or replaying tools',async t=>{
 const s=fixture(t),m=transcript(s),c=new ContextManager(s,cfg);
 const ref=s.put('Observed: input B size 7 failed; size 8 remains untested.','tool:wait_job');
 const saved=summary(ref.id);saved.errors_and_fixes='Input B failed only at size 7.';saved.next_step='Test input B at size 8 and compare.';
 await c.build(m,count,async input=>{assert.ok(!Object.keys(controlPayload(input)).includes('work_state'));return envelope(saved);});
 const before=c.checkpoint(),snapshot=fs.readFileSync(path.join(s.root,'compact-checkpoint.json'));
 const restart=new ContextManager(new Store(s.root),cfg);const rebuilt=await restart.build(m,count,()=>{throw Error('No needless regeneration');});assert.ok(JSON.stringify(rebuilt.messages).includes(ref.id));
 const next={role:'user',content:'Human correction: test size 9 before size 8.',harnessInboxKind:'human'};const ack={role:'assistant',content:[{type:'text',text:'The previous observation is understood; testing the requested new size is pending.'}]};for(const message of [next,ack]){m.push(message);restart.store.append('message',message);}restart.forceCompact=true;
 for(const complete of [async()=>'{broken',async()=>envelope({...saved,next_step:'x'.repeat(10000)}),async()=>{throw Error('model unavailable');}]){
  await assert.rejects(restart.build(m,count,complete));assert.deepEqual(restart.checkpoint(),before);assert.deepEqual(fs.readFileSync(path.join(s.root,'compact-checkpoint.json')),snapshot);
 }
 const updated={...saved,next_step:'Test size 9, as requested by the human.'};
 await restart.build(m,count,async()=>envelope(updated));assert.equal(restart.store.events.filter(e=>e.type==='compact_commit').length,2);
 assert.deepEqual(Object.keys(restart.store.events.findLast(e=>e.type==='compact_commit').data.checkpoint.summary),COMPACT_FIELDS);
 assert.equal(restart.store.events.filter(e=>e.type==='tool_start').length,0);assert.equal(restart.store.pending().length,0);
 assert.ok(!fs.existsSync(path.join(s.root,'work-state.json')));
});

test('actual Pi executes two independent ordinary tools from one generation and receives both paired results',async t=>{
 const s=fixture(t);let generations=0,reads=0;
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:12000}});
  const body=JSON.parse(opt.body);if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  generations++;let delta;
  if(generations===1)delta={tool_calls:[{index:0,id:'read',function:{name:'read',arguments:JSON.stringify({path:'/work/fixture.txt'})}},{index:1,id:'search',function:{name:'read',arguments:JSON.stringify({path:'/work/fixture.txt'})}}]};
  else {const results=body.messages.filter(m=>m.role==='tool');assert.equal(results.length,2);assert.equal(new Set(results.map(r=>r.tool_call_id)).size,2);assert.ok(results.some(r=>r.content.includes('fixture bytes')));delta={content:'Both observations received.'};}
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:generations===1?'tool_calls':'stop'}],usage:{prompt_tokens:1000,completion_tokens:20,total_tokens:1020}})+'\n\ndata: [DONE]\n\n');
 };
 const result=await runTask({id:'multi',objective:'Read two fixture files in one response.'},{runDir:path.join(s.root,'loop'),baseUrl:'http://127.0.0.1:8081',contextTokens:12000,promptTokens:8000,generationTokens:1024,reasoningTokens:256,safetyTokens:64,maxSeconds:30},{guard:()=>{},fetchFn,testMode:true,knowledge:{docs:[]},broker:{validate:async()=>{},readFile:async()=>{reads++;return Buffer.from('fixture bytes');}}});
 assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));assert.equal(generations,2);assert.equal(reads,2);
 const journal=new Store(path.join(s.root,'loop'));assert.equal(journal.events.filter(e=>e.type==='tool_done').length,2);assert.equal(journal.events.filter(e=>e.type==='model_request').length,2);
 assert.ok(journal.events.filter(e=>e.type==='tool_start').every(e=>['read'].includes(e.data.name)));
});
