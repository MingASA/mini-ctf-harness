import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store,hash} from '../src/store.mjs';
import {buildTools} from '../src/tools.mjs';
import {presentMessages} from '../src/tool-output.mjs';
import {ContextManager} from '../src/context.mjs';
const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'tool-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new Store(root);};
const data=r=>JSON.parse(r.content[0].text);

test('public schemas and results carry only command, job and submission semantics',async t=>{
 const store=setup(t),seen=[];
 const broker={start:async(...args)=>{seen.push(args);return {job_id:'j1',status:'running',stdout:'ready',stderr:'',stdout_next_offset:5,stderr_next_offset:0,child:{pid:123},supervisor:{pid:456},time:1234};},read:async(id,wait,offsets)=>{seen.push({id,wait,offsets});return {job_id:id,status:'running',stdout:'ready\n',stderr:''};}};
 const tools=buildTools(store,broker,{}, {submit:()=>({status:'pending',submission_id:'private',candidate_sha256:'private'})});
 assert.deepEqual(tools.map(x=>x.name),['view_image','run_command','wait_job','read','submit_flag']);
 for(const [name,key] of [['run_command','command'],['wait_job','job_id'],['submit_flag','candidate']])assert.deepEqual(Object.keys(tools.find(x=>x.name===name).parameters.properties),[key]);
 const run=data(await tools.find(x=>x.name==='run_command').execute('launch',{command:'printf ready'}));
 assert.deepEqual(run,{status:'running',job_id:'j1',stdout:'ready'});assert.equal(seen[0][3],15);
 const wait=tools.find(x=>x.name==='wait_job');
 for(let i=0;i<2;i++){const out=data(await wait.execute('wait'+i,{job_id:'j1'}));assert.equal(out.status,'running');assert.match(out.message,/120 seconds/);assert.equal(seen.at(-1).wait,120);}
 assert.equal(seen[1].offsets.stdoutOffset,5);
 assert.deepEqual(data(await tools.find(x=>x.name==='submit_flag').execute('candidate',{candidate:'value'})),{status:'pending'});
 const artifact=store.events.find(e=>e.type==='artifact'&&e.data.source==='tool:run_command');assert.ok(store.read(artifact.data.id).text.includes('supervisor'));
});

test('long output is readable with native read while private worker metadata stays in the journal',async t=>{
 const store=setup(t),output='large output\n'.repeat(12000),broker={start:async()=>({job_id:'j1',status:'finished',exit_code:0,stdout:output,supervisor:{pid:987}})};
 const tools=buildTools(store,broker,{},{}),result=await tools.find(x=>x.name==='run_command').execute('long',{command:'cat result'});
 const file=result.content[0].text.match(/Full output: (\S+)\. Use/)[1];
 const read=tools.find(x=>x.name==='read'),full=await read.execute('read',{path:file,offset:1,limit:3});
 assert.ok(full.content[0].text.includes('large output'));
 const tail=await read.execute('read-tail',{path:file,offset:11990,limit:10});assert.equal(tail.isError,undefined);assert.match(tail.content[0].text,/large output/);assert.ok(!full.content[0].text.includes('supervisor'));
 assert.ok(!result.content[0].text.includes('evidence_id'));
 const containerRead=buildTools(store,{config:{workDir:store.root},readFile:async path=>{assert.equal(path,file);return Buffer.from('container output');}}, {},{}).find(t=>t.name==='read');
 assert.equal((await containerRead.execute('container-read',{path:file})).content[0].text,'container output');
 assert.equal(fs.readFileSync(path.join(store.root,'.tool-output',path.basename(file)),'utf8').includes(output),true);
});

test('interrupting a wait ends observation and preserves the existing background job',async t=>{
 const store=setup(t),controller=new AbortController();let started;
 const ready=new Promise(r=>started=r);
 const broker={read:async(id,wait,offsets,signal)=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const tool=buildTools(store,broker,{}, {},()=>{},{signal:()=>controller.signal}).find(x=>x.name==='wait_job');
 const pending=tool.execute('interrupt',{job_id:'j7'});await ready;controller.abort();
 const out=data(await pending);assert.equal(out.status,'running');assert.equal(out.job_id,'j7');assert.match(out.message,/continues/);assert.equal(store.pending().length,0);
});

test('retained legacy tool groups and Compact remain readable without rewriting raw receipts',async t=>{
 const store=setup(t),raw={job_id:'j1',status:'finished',stdout:'kept',exit_code:0,child:{pid:123}};
 const ref=store.put(raw,'tool:run_command');
 const messages=[{role:'user',content:'original'}, {role:'assistant',content:[{type:'toolCall',id:'call',name:'run_command',arguments:{command:'printf kept',seconds:2,reason:'old',evidence:[]}}]}, {role:'toolResult',toolName:'run_command',toolCallId:'call',content:[{type:'text',text:JSON.stringify({preview:JSON.stringify(raw),evidence_id:ref.id})}]}, {role:'user',content:'continue'}];
 messages.forEach(m=>store.append('message',m));
 const summary=Object.fromEntries(['task','constraints','findings','hypotheses','attempts','artifacts','current_work','next_step','open_questions'].map(k=>[k,[]]));
 store.append('compact_commit',{checkpoint:{cut:3,prefixHash:hash(JSON.stringify(messages.slice(0,3))),summary,time:1}});
 const journal=fs.readFileSync(store.file),visible=presentMessages(store,{},messages);
 assert.deepEqual(visible[1].content[0].arguments,{command:'printf kept'});assert.deepEqual(data(visible[2]),{status:'finished',job_id:'j1',exit_code:0,stdout:'kept'});
 const cm=new ContextManager(store,{});assert.doesNotThrow(()=>cm.assemble({role:'system',content:'current'},visible,cm.checkpoint()));
 assert.deepEqual(fs.readFileSync(store.file),journal);
});


test('task JSON stays verbatim and cannot redirect legacy observation reads',t=>{
 const store=setup(t);fs.writeFileSync(path.join(store.root,'secret.json'),JSON.stringify({stdout:'private sentinel'}));
 const text=JSON.stringify({preview:'opaque task data',evidence_id:'../secret.json'}),message={role:'toolResult',toolName:'read',toolCallId:'read',content:[{type:'text',text}]};
 const original=fs.readFileSync;let reads=0;fs.readFileSync=(...args)=>{reads++;return original(...args);};
 try{
  assert.deepEqual(presentMessages(store,{},[message])[0],message);
  assert.deepEqual(presentMessages(store,{},[{...message,content:[{type:'text',text:'null'}]}])[0].content,[{type:'text',text:'null'}]);
  const command=presentMessages(store,{},[{...message,toolName:'run_command'}])[0];assert.ok(!command.content[0].text.includes('private sentinel'));assert.equal(reads,0);
 }finally{fs.readFileSync=original;}
});
