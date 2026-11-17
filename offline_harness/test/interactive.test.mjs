import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {InteractiveSession} from '../src/interactive-session.mjs';
import {ContestQueue} from '../src/contest-queue.mjs';
import {TaskInbox} from '../src/inbox.mjs';
import {Store} from '../src/store.mjs';
import {KvCache} from '../src/kv-cache.mjs';
import {Contest} from '../src/contest.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'contest-test-'));
const tokens=b=>Math.ceil(JSON.stringify({messages:b.messages,tools:b.tools}).length/4);
const config=(root,url)=>({runDir:root,baseUrl:url,contextTokens:30000,promptTokens:15000,generationTokens:1024,reasoningTokens:512,maxSeconds:30,maxTurns:30,maxGeneratedTokens:30000});
async function server(script){let n=0;const requests=[];const app=http.createServer(async(req,res)=>{try{
 if(req.method==='GET'){res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/slots'?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:30000}}));return;}
 let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests.push({route:req.url,body});
 if(req.url.endsWith('input_tokens')){res.end(JSON.stringify({input_tokens:tokens(body)}));return;}
 res.setHeader('content-type','text/event-stream');res.flushHeaders();
 const frame=(delta,finish_reason,usage)=>res.write('data: '+JSON.stringify({choices:[{delta,finish_reason}],usage})+'\n\n');
 await script(++n,body,frame,res);
 }catch(e){res.destroy(e);}});app.listen(0,'127.0.0.1');await once(app,'listening');return {url:'http://127.0.0.1:'+app.address().port,requests,close:()=>new Promise(r=>{app.close(r);app.closeAllConnections();})};}
const done=(body,frame,res,text='Ready for operator')=>{frame({content:text},'stop',{prompt_tokens:tokens(body),completion_tokens:10,total_tokens:tokens(body)+10});res.end('data: [DONE]\n\n');};
const knowledge={search:()=>[],read:()=>{throw Error('No fixture skill');}};
const broker={validate:async()=>{},checkCommand:()=>{}};

test('incremental Pi output arrives before completion; a mid-stream task note is delivered next and final text keeps session open',async()=>{
 const root=temp();let release;const gate=new Promise(r=>release=r);let first;
 const received=new Promise(r=>first=r);
 const p=await server(async(n,b,f,res)=>{if(n===1){f({content:'live first '});first();await gate;}done(b,f,res,'final '+n);});
 try{
  const s=new InteractiveSession({id:'alpha',objective:'Synthetic persistence fixture'},config(root,p.url),{broker,knowledge,guard:()=>{}});
  let delta=false;s.on('agent',e=>{if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta')delta=true;});
  const running=s.runSlice();await received;await new Promise(r=>setTimeout(r,20));assert.equal(delta,true);
  const note=s.enqueue('Correction belongs to alpha');assert.equal(s.inbox.items()[0].status,'queued');release();
  const result=await running;assert.equal(result.status,'awaiting_input');assert.equal(s.inbox.items()[0].status,'delivered');
  const requests=p.requests.filter(r=>r.route==='/v1/chat/completions');assert.equal(requests.length,2);assert.ok(!JSON.stringify(requests[0]).includes(note.text));assert.ok(JSON.stringify(requests[1]).includes(note.text));
  const reopened=new InteractiveSession(s.task,config(root,p.url),{broker,knowledge,guard:()=>{}});reopened.enqueue('Another turn after restart');assert.equal((await reopened.runSlice()).status,'awaiting_input');assert.equal(reopened.inbox.items().length,2);
 }finally{release();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('pausing an incomplete tool SSE never executes it and does not cancel existing commands',async()=>{
 const root=temp();let started;const ready=new Promise(r=>started=r);let commands=0,cancels=0;
 const p=await server(async(n,b,f,res)=>{f({tool_calls:[{index:0,id:'x',function:{name:'run_command',arguments:'{"command":"printf x","seconds":1,"reason":"fixture"}'}}]});started();await new Promise(r=>res.once('close',r));});
 try{const s=new InteractiveSession({id:'pause',objective:'Pause fixture'},config(root,p.url),{broker:{...broker,start:async()=>commands++,cancel:async()=>cancels++},knowledge,guard:()=>{}});const work=s.runSlice();await ready;s.pause();assert.equal((await work).status,'paused');assert.equal(commands,0);assert.equal(cancels,0);assert.equal(s.store.pending().length,0);assert.equal(s.budget().generated,1024);assert.equal(s.budget().turns,1);}finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});





test('KV checkpoint always saves conversation; missing server capability is explicit and foreign identity never restores',async()=>{
 const root=temp();try{const s={task:{id:'kv'},store:new Store(root),messages:()=>[{role:'user',content:'fixture'}]};const kv=new KvCache({model:'fixture',baseUrl:'http://127.0.0.1:9'},{guard:()=>{},fetchFn:()=>{throw Error('must not contact server');}});assert.equal((await kv.save(s)).status,'unavailable');assert.ok(fs.existsSync(path.join(root,'conversation-checkpoint.json')));s.store.snapshot('kv-checkpoint',{taskId:'other',identity:'foreign'});kv.config.kv={enabled:true};assert.equal((await kv.restore(s)).status,'stale');}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('competition yields on a command, runs another task, and resumes returned work before a fresh task',async()=>{
 const root=temp();let finished=false;const seen=[];
 const p=await server(async(n,b,f,res)=>{
  const id=JSON.stringify(b.messages).includes('fixture-alpha')?'alpha':JSON.stringify(b.messages).includes('fixture-beta')?'beta':'gamma';seen.push(id);
  if(seen.filter(x=>x===id).length===1&&id==='alpha'){
   f({tool_calls:[{index:0,id:'cmd',function:{name:'run_command',arguments:JSON.stringify({command:'printf fixture'})}}]},'tool_calls',{prompt_tokens:tokens(b),completion_tokens:10});res.end('data: [DONE]\n\n');
  }else done(b,f,res);
 });
 let c;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:config('',p.url)},{testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {workDir,containerId:id};},sessionOptions:record=>({knowledge,broker:{...broker,start:async()=>{const s=c.session(record.task.id);s.store.append('job_started',{job_id:'a'.repeat(32)});return {job_id:'a'.repeat(32),status:'started'};},read:async()=>({status:finished?'finished':'running',stdout:finished?'measurement ready':''})}})});
  await c.add({id:'alpha',objective:'fixture-alpha'});await c.add({id:'beta',objective:'fixture-beta'});c.enabled=true;
  await c.tick();assert.equal(c.status('alpha'),'waiting_tool');await c.tick();assert.equal(c.status('beta'),'awaiting_input');
  await c.add({id:'gamma',objective:'fixture-gamma'});finished=true;await c.tick();assert.deepEqual(seen,['alpha','alpha','beta','alpha']);assert.equal(c.status('alpha'),'awaiting_input');assert.equal(c.status('gamma'),'ready_fresh');
  c.enqueue('beta','Operator correction beta only');await c.tick();assert.equal(seen.at(-1),'beta');assert.equal(c.session('beta').inbox.items()[0].status,'delivered');assert.equal(c.session('alpha').inbox.items().some(x=>x.text.includes('beta only')),false);
 }finally{await c?.close();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('candidate records use exact values and manual platform rejection resumes the same persistent task',async()=>{
 const root=temp();let evidence;
 const p=await server(async(n,b,f,res)=>{if(n===1){f({tool_calls:[{index:0,id:'candidate',function:{name:'submit_flag',arguments:JSON.stringify({candidate:'synthetic-candidate'})}}]},'tool_calls',{prompt_tokens:tokens(b),completion_tokens:10});res.end('data: [DONE]\n\n');}else done(b,f,res);});
 try{const s=new InteractiveSession({id:'candidate',objective:'Synthetic submission fixture'},config(root,p.url),{broker,knowledge,guard:()=>{}});evidence=s.store.put('fixture observation','tool:wait_job').id;assert.equal((await s.runSlice()).status,'awaiting_review');const candidate=s.candidates()[0];assert.equal(candidate.review_id,'c1');assert.equal(candidate.evidence,undefined);s.feedback(candidate.id,'incorrect','platform rejected format');assert.equal((await s.runSlice()).status,'awaiting_input');assert.ok(JSON.stringify(p.requests.at(-1)).includes('platform rejected format'));assert.throws(()=>s.feedback(candidate.id,'correct'),/final feedback/);}finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('asynchronous RAG results enter retained evidence and wait without blocking inference',async()=>{
 const root=temp();let complete=false;
 const p=await server(async(n,b,f,res)=>{if(n===1){f({tool_calls:[{index:0,id:'search',function:{name:'rag_search',arguments:'{"query":"generic retrieval fixture"}'}}]},'tool_calls',{prompt_tokens:tokens(b),completion_tokens:10});res.end('data: [DONE]\n\n');}else done(b,f,res);});
 try{const s=new InteractiveSession({id:'rag-fixture',objective:'Generic retrieval fixture'},config(root,p.url),{broker,knowledge,guard:()=>{},remote:{rag:{submit:async()=>({jobId:'fixture-job',status:'queued'}),status:async()=>({status:complete?'completed':'running'}),result:async()=>({status:'completed',hits:[{text:'document',citation:{source:'fixture.txt',sha256:'f'.repeat(64)}}]})}}});assert.equal((await s.runSlice()).status,'waiting_service');assert.equal((await s.collect()).length,1);complete=true;assert.equal((await s.collect()).length,0);assert.equal(s.store.search('document').length,1);assert.equal((await s.runSlice()).status,'awaiting_input');assert.equal(s.inbox.items()[0].status,'delivered');}finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('manual inference switch waits for complete turn and records distinct conversation and verified KV receipts',async()=>{
 const root=temp();let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const calls=[];
 const p=await server(async(n,b,f,res)=>{if(n===1){f({content:'partial'});started();await gate;}done(b,f,res);});let c;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{...config('',p.url),kv:{enabled:true,identity:'fixture-engine-hash',slot:0}}},{testMode:true,guard:()=>{},kvFetch:async(url,opt)=>{
   calls.push(url);const body=opt.body?JSON.parse(opt.body):{};
   return {ok:true,json:async()=>url.endsWith('/slots')?[{id:0,is_processing:false}]:url.includes('action=save')?{id_slot:0,filename:body.filename,n_saved:23,n_written:1234}:{id_slot:0,filename:body.filename,n_restored:23,n_read:1234}};
  },provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {workDir,containerId:id};},sessionOptions:()=>({broker,knowledge})});
  await c.add({id:'alpha',objective:'alpha'});await c.add({id:'beta',objective:'beta'});c.enabled=true;const running=c.tick();await ready;c.switchInference('beta');assert.equal(c.active,'alpha');assert.equal(calls.length,0);release();await running;
  assert.equal(c.session('alpha').store.events.find(e=>e.type==='checkpoint_result').data.status,'saved');assert.equal(c.session('alpha').store.events.find(e=>e.type==='checkpoint_result').data.conversationSaved,true);
  await c.tick();assert.equal(c.status('beta'),'awaiting_input');await c.tick();assert.ok(calls.some(x=>x.includes('action=restore')));assert.ok(c.session('alpha').store.events.some(e=>e.type==='kv_restored'));
 }finally{release();await c?.close();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('missing remote job becomes explicit failed evidence and crash after result commit recovers its inbox delivery',async()=>{
 const root=temp();try{
  const cfg=config(root,'http://127.0.0.1:9'),opts={broker,knowledge,guard:()=>{},remote:{rag:{status:async()=>{throw Object.assign(Error('Missing job'),{status:404});}}}};
  const s=new InteractiveSession({id:'recover',objective:'Synthetic job recovery'},cfg,opts);s.trackDependency('rag','expired');await s.collect();assert.equal(s.dependencies().length,0);assert.match(s.inbox.items()[0].text,/JOB_NOT_FOUND/);
  const ref=s.store.put({status:'completed',text:'durably completed before inbox append'},'tool:rag');s.store.append('dependency_done',{key:'rag:crash',kind:'rag',id:'crash',result_status:'completed',evidence_id:ref.id});
  const restarted=new InteractiveSession(s.task,cfg,opts);assert.equal(restarted.inbox.items().length,2);assert.match(restarted.inbox.items()[1].text,/durably completed before inbox append/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('contest restart reconciles a committed dependency result into the resume queue without replay',async()=>{
 const root=temp();let c;
 const cfg={contestDir:path.join(root,'contest'),model:config('', 'http://127.0.0.1:9')},options={testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {workDir,containerId:id};},sessionOptions:()=>({broker,knowledge})};
 try{
  c=new Contest(cfg,options);await c.add({id:'resume',objective:'recovery fixture'});const s=c.session('resume');s.trackDependency('rag','committed');c.queue.settle('resume','waiting_service',s.dependencies());
  const ref=s.store.put({status:'completed',text:'saved retrieval'},'tool:rag');s.store.append('dependency_done',{key:'rag:committed',kind:'rag',id:'committed',result_status:'completed',evidence_id:ref.id});await c.close();
  c=new Contest(cfg,options);assert.equal(c.status('resume'),'ready_resume');assert.equal(c.session('resume').inbox.items().length,1);assert.equal(c.session('resume').dependencies().length,0);
 }finally{await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
