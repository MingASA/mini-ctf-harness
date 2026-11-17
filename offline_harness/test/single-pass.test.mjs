import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ContextManager,wire,groups} from '../src/context.mjs';
import {Store} from '../src/store.mjs';
import {buildTools} from '../src/tools.mjs';
import {taskClock} from '../src/task-clock.mjs';
import {envelope,summary,controlPayload} from './compact-fixture.mjs';
const config={contextTokens:65536,promptTokens:51200,compactSoftTokens:51200,compactHardTokens:55296,generationTokens:8192,safetyTokens:2048,compactTokens:4096,compactTailGroups:0};
const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'single-pass-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root);store.append('task',{task:{id:'x',objective:'Synthetic fixture'}});return store;};
const count=async input=>input.messages.reduce((n,m)=>n+(typeof m.content==='string'?Math.ceil(m.content.length/4):m.content.reduce((n,x)=>n+(x.type==='image_url'?1024:Math.ceil(x.text.length/4)),0)),20);
function messages(store){
 const data=Buffer.from('IMAGE_BYTE_SENTINEL'.repeat(1600)).toString('base64');
 const m=[{role:'system',content:'Stable contract',timestamp:1},{role:'user',content:'Examine synthetic fixture'},
 {role:'assistant',content:[{type:'toolCall',id:'image-call',name:'view_image',arguments:{path:'/work/test.png'}}]},
 {role:'toolResult',toolName:'view_image',toolCallId:'image-call',content:[{type:'text',text:'UNIQUE_TOOL_OBSERVATION'},{type:'image',mimeType:'image/png',data}]},
 {role:'assistant',content:[{type:'text',text:'The visual result needs testing.'}]}];
 store.append('tool_start',{callId:'image-call',name:'view_image',args:{path:'/work/test.png'}});
 store.append('tool_done',{callId:'image-call',result:m[3]});
 for(const x of m)store.append('message',x);
 return {m,data};
}
test('one compact call preserves native pixels, consumes each canonical tool result once, and commits only the nine-field checkpoint',async t=>{
 const store=setup(t),{m,data}=messages(store),cm=new ContextManager(store,config);cm.forceCompact=true;let calls=0;
 const built=await cm.build(m,count,async(input,options)=>{
  calls++;assert.equal(options.kind,'compact');assert.deepEqual(input.tools,[]);
  assert.equal(input.messages.filter(x=>x.role==='tool').length,1);
  assert.equal(JSON.stringify(input).split('UNIQUE_TOOL_OBSERVATION').length-1,1);
  const texts=input.messages.flatMap(x=>typeof x.content==='string'?[x.content]:x.content.filter(p=>p.type==='text').map(p=>p.text)).join('\n');
  assert.ok(!texts.includes(data));assert.ok(!texts.includes('IMAGE_BYTE_SENTINEL'));
  const image=input.messages.flatMap(x=>Array.isArray(x.content)?x.content:[]).find(p=>p.type==='image_url');assert.equal(image.image_url.url,'data:image/png;base64,'+data);
  assert.equal(controlPayload(input).previous_compact_in_prefix,false);
  return envelope(summary());
 });
 assert.equal(calls,1);assert.deepEqual(Object.keys(cm.checkpoint().summary),Object.keys(summary()));assert.equal(store.events.filter(e=>e.type==='compact_commit').length,1);
 assert.equal(store.events.filter(e=>e.type==='compact_commit')[0].data.model_calls,1);assert.ok(!JSON.stringify(built.messages).includes(data));groups(built.messages.filter(x=>x.role!=='system'));
 const next={role:'assistant',content:[{type:'text',text:'New post-compact activity'}]};m.push(next);store.append('message',next);cm.forceCompact=true;
 await cm.build(m,count,async input=>{const p=controlPayload(input);assert.equal(p.previous_compact_in_prefix,true);assert.ok(input.messages.some(m=>typeof m.content==='string'&&m.content.includes(JSON.stringify(summary()))));assert.ok(!Object.keys(p).includes('work_state'));assert.ok(!JSON.stringify(input).includes(data));assert.ok(JSON.stringify(input).includes('New post-compact activity'));return envelope();});
 assert.equal(store.events.filter(e=>e.type==='compact_commit').length,2);
});
test('bounded mixed output keeps image blocks and leaves raw evidence intact',t=>{
 const store=setup(t),cm=new ContextManager(store,config),image={type:'image',mimeType:'image/png',data:'YWJj'},message={role:'toolResult',content:[{type:'text',text:'long '.repeat(2000)},image]};
 const bounded=cm.bounded([message])[0];assert.deepEqual(bounded.content[1],image);assert.ok(JSON.stringify(message).length>JSON.stringify(bounded).length);
 const file=bounded.content[0].text.match(/Full output: (\S+)\./)[1];assert.ok(fs.readFileSync(path.join(store.root,'.tool-output',path.basename(file)),'utf8').includes('long '));
});
test('invalid JSON, invalid summary and native failures preserve the previous checkpoint and messages',async t=>{
 const store=setup(t),{m}=messages(store),cm=new ContextManager(store,config);cm.forceCompact=true;
 const original=structuredClone(m);
 for(const respond of [async()=>'{broken',async()=>JSON.stringify({compact:{}}),async()=>{throw Error('native unavailable');}]){
  await assert.rejects(cm.build(m,count,respond));assert.deepEqual(m,original);assert.equal(cm.checkpoint(),undefined);
 }
});
test('wait_job delivers only new bytes across polling and restart, and preserved full output',async t=>{
 const store=setup(t),id='a'.repeat(32);let stdout='first\n';const broker={read:async()=>({job_id:id,status:'running',stdout,stderr:''})};
 let tool=buildTools(store,broker,{},{}).find(x=>x.name==='wait_job');
 const preview=async(call,args={})=>JSON.parse((await tool.execute(call,{job_id:id,...args})).content[0].text);
 assert.equal((await preview('first')).stdout,'first\n');assert.equal((await preview('no-change')).stdout,'');stdout+='second\n';
 tool=buildTools(new Store(store.root),broker,{},{}).find(x=>x.name==='wait_job');assert.equal((await preview('after-restart')).stdout,'second\n');assert.equal((await preview('unchanged')).stdout,'');
});
test('one durable wall deadline includes repair gaps and compact; never resets on session restart',t=>{
 const store=setup(t),cfg={maxSeconds:2400};const first=taskClock(store,cfg,{now:100000,start:true,startedUnix:10,deadlineUnix:2410});assert.equal(first.millisecondsRemaining,2310000);
 const restored=taskClock(new Store(store.root),cfg,{now:2410001,start:true});assert.equal(restored.millisecondsRemaining,0);assert.equal(restored.elapsedWallMs,2400001);
 assert.throws(()=>taskClock(store,cfg,{now:200000,start:true,deadlineUnix:2600}),/changed/);
});
test('one-pass over-cap input fails before model generation without dropping history or spawning batches',async t=>{
 const store=setup(t),{m}=messages(store),cm=new ContextManager(store,config);cm.forceCompact=true;let calls=0;
 await assert.rejects(cm.build(m,async()=>1000000,async()=>{calls++;return envelope();}),/Full-prefix Compact exceeds exact capacity/);
 assert.equal(calls,0);assert.equal(cm.checkpoint(),undefined);assert.equal(store.events.filter(e=>e.type==='message').length,m.length);
 assert.equal(store.events.at(-1).type,'compact_end');assert.equal(store.events.at(-1).data.status,'failed');
});
test('resuming a stopped task unfreezes elapsed time without extending its deadline',t=>{
 const store=setup(t),cfg={maxSeconds:2400};taskClock(store,cfg,{start:true,startedUnix:10,deadlineUnix:2410,now:100000});
 const end=store.append('task_clock_end',{status:'model_stopped_without_verified_answer'});
 const ended=taskClock(store,cfg,{now:end.time+60000});assert.equal(ended.elapsedWallMs,end.time-10000);
 const resumed=taskClock(store,cfg,{start:true,now:end.time+60000});assert.equal(resumed.deadlineUnix,2410);assert.equal(resumed.millisecondsRemaining,0);assert.equal(resumed.elapsedWallMs,end.time+60000-10000);
});
