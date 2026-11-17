import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {InteractiveSession} from '../src/interactive-session.mjs';
import {Contest} from '../src/contest.mjs';
import {KvCache} from '../src/kv-cache.mjs';
import {COMPACT_FIELDS} from '../src/compact-prompts.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'interactive-controls-'));
const tokens=b=>Math.ceil(JSON.stringify({messages:b.messages,tools:b.tools}).length/4);
const config=(root,url)=>({runDir:root,baseUrl:url,contextTokens:30000,promptTokens:15000,generationTokens:1024,reasoningTokens:512,compactTokens:1024,compactTailGroups:0,compactThinking:true,compactReasoningEffort:'xhigh',compactReasoningTokens:256,maxSeconds:30,maxTurns:40,maxGeneratedTokens:40000});
const opts={broker:{validate:async()=>{},checkCommand:()=>{}},knowledge:{search:()=>[]},guard:()=>{}};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const settle=()=>new Promise(r=>setTimeout(r,15));
const summary=()=>JSON.stringify(Object.fromEntries(COMPACT_FIELDS.map(k=>[k,'Synthetic verified observation'])));
async function fixture(script,{template='changed'}={}){
 const requests=[],errors=[];let n=0;
 const app=http.createServer(async(req,res)=>{try{
  if(req.method==='GET'){requests.push({route:req.url});res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/slots'?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:30000}}));return;}
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests.push({route:req.url,body});
  if(req.url.endsWith('input_tokens')){res.end(JSON.stringify({input_tokens:tokens(body)}));return;}
  if(req.url==='/apply-template'){if(template==='unsupported'){res.statusCode=404;res.end('{}');return;}res.end(JSON.stringify({prompt:JSON.stringify(body.messages)+(template==='same'?'AAAA':body.chat_template_kwargs.enable_thinking===false?'OOOO':body.chat_template_kwargs.reasoning_effort==='medium'?'MMMM':'XXXX')}));return;}
  if(req.url==='/tokenize'){res.end(JSON.stringify({tokens:Array.from(body.content,c=>c.codePointAt(0))}));return;}
  assert.equal(req.url,'/v1/chat/completions');res.setHeader('content-type','text/event-stream');res.flushHeaders();
  const frame=(delta,finish_reason,usage)=>res.write('data: '+JSON.stringify({choices:[{delta,finish_reason}],usage})+'\n\n');
  await script(++n,body,frame,res);
 }catch(e){errors.push(e.message);res.destroy(e);}});
 app.listen(0,'127.0.0.1');await once(app,'listening');return {requests,errors,url:'http://127.0.0.1:'+app.address().port,close:()=>new Promise(r=>{app.close(r);app.closeAllConnections();})};
}
const done=(b,f,r,text='Ready')=>{f({content:text},'stop',{prompt_tokens:tokens(b),completion_tokens:10});r.end('data: [DONE]\n\n');};
const generations=p=>p.requests.filter(r=>r.route==='/v1/chat/completions').map(r=>r.body);

test('operator interrupt retains exact reasoning, text and raw tool drafts across restart; resume never replays drafts',async()=>{
 const root=temp(),ready=deferred();let commands=0;
 const p=await fixture(async(n,b,f,res)=>{if(n===1){f({reasoning_content:'先核对 A，再验证 B。',content:'已得到的部分结论',tool_calls:[{index:0,id:'draft',function:{name:'run_command',arguments:'{"command":"must not execute"'}}]});ready.resolve();await new Promise(r=>res.once('close',r));}else done(b,f,res);});
 try{
  const cfg=config(root,p.url),task={id:'retain',objective:'Preserve interrupted output'},options={...opts,broker:{...opts.broker,start:async()=>commands++}};
  let s=new InteractiveSession(task,cfg,options);const work=s.runSlice();await ready.promise;await settle();s.pause();assert.equal((await work).status,'paused');assert.equal(commands,0);
  const last=s.messages().at(-1);assert.equal(last.harnessOperatorInterrupted,true);assert.equal(last.content.find(p=>p.type==='thinking').thinking,'先核对 A，再验证 B。');assert.equal(last.content.find(p=>p.type==='text').text,'已得到的部分结论');
  assert.equal(last.content.some(p=>p.type==='toolCall'),false);const evidence=JSON.parse(s.store.read(last.harnessInterruptedEvidence).text);assert.equal(evidence.drafts[0].arguments,'{"command":"must not execute"');assert.match(fs.readFileSync(evidence.raw_file,'utf8'),/must not execute/);
  assert.equal(s.budget().generated,1024);s=new InteractiveSession(task,cfg,options);assert.deepEqual(s.messages().at(-1),last);
  assert.equal((await s.runSlice()).status,'awaiting_input');assert.equal(commands,0);assert.equal(generations(p).length,2);assert.match(JSON.stringify(generations(p)[1]),/已得到的部分结论/);assert.equal(s.inbox.items().filter(x=>x.id.startsWith('interrupt-')).length,1);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('effort changes are durable before history, wait for the next request during generation, and preserve Compact profile',async()=>{
 const root=temp(),ready=deferred(),gate=deferred();
 const p=await fixture(async(n,b,f,res)=>{if(n===1){f({content:'in progress'});ready.resolve();await gate.promise;}done(b,f,res,b.response_format?summary():'Ready');});
 try{
  const cfg=config(root,p.url),task={id:'effort',objective:'Generic effort control'};let s=new InteractiveSession(task,cfg,opts);
  s.requestEffort('low','-1');assert.equal(p.requests.length,0);assert.equal(s.config.reasoningEffort,'low');assert.equal(s.config.reasoningTokens,-1);
  s=new InteractiveSession(task,cfg,opts);assert.equal(s.config.reasoningEffort,'low');const work=s.runSlice();await ready.promise;
  s.requestEffort('off');s.enqueue('Continue with the new setting');assert.equal(s.config.thinking,true);gate.resolve();assert.equal((await work).status,'awaiting_input');
  const [a,b]=generations(p);assert.equal(a.chat_template_kwargs.reasoning_effort,'low');assert.equal(a.chat_template_kwargs.enable_thinking,true);assert.equal(b.chat_template_kwargs.enable_thinking,false);assert.equal(b.temperature,0.7);assert.equal(b.top_p,0.8);
  assert.equal(s.store.events.findLast(e=>e.type==='generation_prefix_check').data.status,'changed');
  s.requestCompact();assert.equal((await s.runSlice({maintenanceOnly:true})).status,'awaiting_input');const compact=generations(p).at(-1);assert.equal(compact.chat_template_kwargs.reasoning_effort,'xhigh');assert.equal(compact.chat_template_kwargs.enable_thinking,true);assert.equal(compact.reasoning_budget_tokens,256);assert.equal(s.store.events.filter(e=>e.type==='compact_commit').length,1);
  const reopened=new InteractiveSession(task,cfg,opts);assert.equal(reopened.config.thinking,false);assert.equal(reopened.config.reasoningTokens,-1);assert.throws(()=>s.requestEffort('high','1024'),/total response/);
 }finally{gate.resolve();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const template of ['same','changed','unsupported'])test('actual rendered token identity handles '+template+' templates without resetting slots',async()=>{
 const root=temp();const p=await fixture(async(n,b,f,res)=>done(b,f,res),{template});
 try{
  const s=new InteractiveSession({id:'prefix',objective:'Template comparison'},config(root,p.url),opts);await s.runSlice();s.requestEffort('xhigh','768');s.enqueue('Next request');await s.runSlice();assert.equal(generations(p).at(-1).reasoning_budget_tokens,768);
  const check=s.store.events.findLast(e=>e.type==='generation_prefix_check').data;assert.equal(check.status,{same:'unchanged',changed:'changed',unsupported:'unknown'}[template]);
  if(template==='changed'){assert.equal(check.before_tokens,check.after_tokens);assert.notEqual(check.before_sha,check.after_sha);}
  if(template==='same')assert.equal(check.before_sha,check.after_sha);
  assert.equal(p.requests.some(r=>r.route.includes('action=')),false);assert.ok(generations(p).every(b=>b.cache_prompt&&b.id_slot===0));
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('manual Compact waits for a complete tool group and commits once before the next solving request',async()=>{
 const root=temp(),ready=deferred(),gate=deferred();let commandFinished=false;
 const p=await fixture(async(n,b,f,res)=>{
  if(n===1){done(b,f,res);return;}
  if(n===2){f({content:'checking fixture'});ready.resolve();await gate.promise;f({tool_calls:[{index:0,id:'check',function:{name:'run_command',arguments:JSON.stringify({command:'printf fixture'})}}]},'tool_calls',{prompt_tokens:tokens(b),completion_tokens:10});res.end('data: [DONE]\n\n');}
  else if(b.response_format){assert.equal(commandFinished,true);assert.equal(b.messages.at(-2).role,'tool');done(b,f,res,summary());}
  else done(b,f,res);
 });
 try{
  const s=new InteractiveSession({id:'boundary',objective:'Complete tool boundary'},config(root,p.url),{...opts,broker:{...opts.broker,start:async()=>{commandFinished=true;return {job_id:'j1',status:'finished',stdout:'fixture',exit_code:0};},read:async()=>({job_id:'j1',status:'finished',stdout:'fixture',exit_code:0})}});
  await s.runSlice();s.enqueue('Now inspect the fixture');const work=s.runSlice();await ready.promise;s.requestCompact();gate.resolve();assert.equal((await work).status,'awaiting_input');
  assert.equal(s.store.events.filter(e=>e.type==='compact_commit').length,1,JSON.stringify({events:s.store.events.filter(e=>['compact_resolved','model_error'].includes(e.type)),errors:p.errors,requests:generations(p).map(b=>b.messages.map(m=>m.role))}));assert.equal(s.pendingControl('compact'),undefined);assert.equal(generations(p).filter(b=>b.response_format).length,1);assert.equal(generations(p).length,4);
 }finally{gate.resolve();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('idle Compact generates only a summary, survives restart, and interruption retains its old checkpoint',async()=>{
 const root=temp(),ready=deferred();let abortCompact=false;
 const p=await fixture(async(n,b,f,res)=>{if(b.response_format&&abortCompact){f({reasoning_content:'retain this compact reasoning',content:'{"primary_request_and_intent":"partial'});ready.resolve();await new Promise(r=>res.once('close',r));}else done(b,f,res,b.response_format?summary():'Ready');});
 try{
  const cfg=config(root,p.url),task={id:'compact',objective:'Compact lifecycle'};let s=new InteractiveSession(task,cfg,opts);
  s.requestCompact();assert.equal((await s.runSlice({maintenanceOnly:true})).status,'awaiting_input');assert.equal(p.requests.length,0);
  await s.runSlice();s.requestCompact();s=new InteractiveSession(task,cfg,opts);await s.runSlice({maintenanceOnly:true});const checkpoint=s.store.events.findLast(e=>e.type==='compact_commit');assert.ok(checkpoint);assert.equal(generations(p).length,2);
  s.enqueue('New observation after the checkpoint');await s.runSlice();abortCompact=true;s.requestCompact();const work=s.runSlice({maintenanceOnly:true});await ready.promise;await settle();s.pause();assert.equal((await work).status,'paused');assert.deepEqual(s.store.events.findLast(e=>e.type==='compact_commit'),checkpoint);
  assert.equal(s.store.events.findLast(e=>e.type==='compact_resolved').data.status,'interrupted');const ref=s.store.events.findLast(e=>e.type==='model_auxiliary_interrupted').data.evidence_id;const partial=JSON.parse(s.store.read(ref).text);assert.equal(partial.reasoning,'retain this compact reasoning');assert.match(partial.content,/partial/);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('Ctrl+C stops scheduling, holds the model lease and resident KV, and resumes the same task after human input',async()=>{
 const root=temp(),ready=deferred();let c;
 const p=await fixture(async(n,b,f,res)=>{if(n===1){f({content:'retain current text'});ready.resolve();await new Promise(r=>res.once('close',r));}else done(b,f,res);});
 try{
  c=new Contest({contestDir:path.join(root,'contest'),modelLease:path.join(root,'lease.json'),model:{...config('',p.url),kv:{enabled:true,identity:'fixture'}}},{...opts,provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {workDir,containerId:id};},sessionOptions:()=>opts,kvFetch:()=>{throw Error('Resident KV must not be restored, saved or erased');}});
  await c.add({id:'alpha',objective:'active task'});await c.add({id:'beta',objective:'queued task'});c.enabled=true;const work=c.tick();await ready.promise;await settle();assert.equal(c.interruptActive(),'alpha');await work;
  assert.equal(c.status('alpha'),'paused');assert.equal(c.enabled,false);assert.equal(c.resident,'alpha');assert.ok(fs.existsSync(c.lease));await c.tick();assert.equal(generations(p).length,1);assert.equal(c.status('beta'),'ready_fresh');
  c.enqueue('alpha','Human correction after interrupt');await c.execution;await settle();if(c.busy)await c.execution;assert.equal(c.status('alpha'),'awaiting_input');assert.equal(generations(p).length,2);assert.match(JSON.stringify(generations(p)[1]),/Human correction after interrupt/);assert.equal(c.resident,'alpha');
  c.interruptActive();await c.close();assert.equal(fs.existsSync(path.join(root,'lease.json')),false);
 }finally{await c?.close();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('serialized KV is rejected when generation settings or Compact view changed',async()=>{
 const root=temp();let calls=0;
 try{
  const s=new InteractiveSession({id:'snapshot',objective:'KV profile identity'},config(root,'http://127.0.0.1:9'),opts);s.config.kv={enabled:true,identity:'fixture'};
  const body={max_tokens:1024,chat_template_kwargs:{enable_thinking:true,reasoning_effort:'medium'},reasoning_budget_tokens:512};s.store.append('model_request',{requestId:1,body});s.store.append('model_interrupted',{requestId:1});
  const kv=new KvCache(s.config,{guard:()=>{},fetchFn:async(url,opt)=>{calls++;const b=opt.body?JSON.parse(opt.body):{};return {ok:true,json:async()=>url.endsWith('/slots')?[{id:0,is_processing:false}]:url.includes('action=save')?{id_slot:0,filename:b.filename,n_saved:10,n_written:100}:{id_slot:0,filename:b.filename,n_restored:10,n_read:100}};}});
  assert.equal((await kv.save(s)).status,'saved');assert.equal((await kv.restore(s)).status,'restored');s.requestEffort('low');const before=calls;assert.equal((await kv.restore(s)).status,'stale');assert.equal(calls,before);s.requestEffort('medium');s.store.append('compact_commit',{checkpoint:{}});assert.equal((await kv.restore(s)).status,'stale');assert.equal(calls,before);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('interrupt during broker preparation cannot be cleared by the later model start',async()=>{
 const root=temp(),ready=deferred(),gate=deferred();
 try{
  const s=new InteractiveSession({id:'prepare',objective:'Preparation race'},config(root,'http://127.0.0.1:9'),{...opts,broker:{validate:async()=>{ready.resolve();await gate.promise;}},fetchFn:()=>{throw Error('Interrupted preparation must not contact the model');}});
  const work=s.runSlice();await ready.promise;s.pause();gate.resolve();assert.equal((await work).status,'paused');assert.equal(s.store.events.some(e=>e.type==='model_request'),false);
 }finally{gate.resolve();fs.rmSync(root,{recursive:true,force:true});}
});

test('interrupt between two tools retains the completed receipt and blocks the remaining tool without replay',async()=>{
 const root=temp(),ready=deferred(),gate=deferred();let commands=0;
 const p=await fixture(async(n,b,f,res)=>{
  if(n===1){f({tool_calls:[0,1].map(index=>({index,id:'call'+index,function:{name:'run_command',arguments:JSON.stringify({command:'printf '+index})}}))},'tool_calls',{prompt_tokens:tokens(b),completion_tokens:10});res.end('data: [DONE]\n\n');}
  else done(b,f,res);
 });
 try{
  const s=new InteractiveSession({id:'tools',objective:'Interrupt a tool batch'},config(root,p.url),{...opts,broker:{...opts.broker,start:async()=>{commands++;ready.resolve();await gate.promise;return {job_id:'j1',status:'finished',stdout:'committed result',exit_code:0};}}});
  const work=s.runSlice();await ready.promise;s.pause();gate.resolve();assert.equal((await work).status,'paused');assert.equal(commands,1);assert.equal(s.store.pending().length,0);assert.equal(s.messages().filter(m=>m.role==='toolResult').length,2);
  assert.ok(JSON.stringify(s.messages()).includes('committed result'));assert.ok(JSON.stringify(s.messages()).includes('Operator paused inference'));assert.equal((await s.runSlice()).status,'awaiting_input');assert.equal(commands,1);
 }finally{gate.resolve();await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('Compact failure retains history and an interactive session remains usable',async()=>{
 const root=temp();const p=await fixture(async(n,b,f,res)=>done(b,f,res,b.response_format?'invalid JSON':'Ready'));
 try{
  const s=new InteractiveSession({id:'bad-summary',objective:'Failed summary'},config(root,p.url),opts);await s.runSlice();const before=s.messages();s.requestCompact();await s.runSlice({maintenanceOnly:true});assert.equal(s.store.events.findLast(e=>e.type==='compact_resolved').data.status,'failed');assert.equal(s.store.events.some(e=>e.type==='compact_commit'),false);assert.deepEqual(s.messages(),before);
  s.enqueue('Continue from original evidence');assert.equal((await s.runSlice()).status,'awaiting_input');assert.equal(generations(p).length,3);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('manual Compact obeys the cumulative active budget even without a normal generation',async()=>{
 const root=temp(),ready=deferred();let hang=false;
 const p=await fixture(async(n,b,f,res)=>{if(b.response_format&&hang){f({reasoning_content:'Working within the remaining budget'});ready.resolve();await new Promise(r=>res.once('close',r));}else done(b,f,res);});
 try{
  const s=new InteractiveSession({id:'budget',objective:'Bound auxiliary generation'},{...config(root,p.url),maxSeconds:1},opts);await s.runSlice();hang=true;s.requestCompact();const work=s.runSlice({maintenanceOnly:true});await ready.promise;assert.equal((await work).status,'budget_exhausted');assert.equal(s.store.events.some(e=>e.type==='compact_commit'),false);assert.ok(s.budget().millisecondsRemaining<30);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('resuming an owned interrupted stream tolerates a short backend cancellation drain',async()=>{
 const root=temp(),ready=deferred();let draining=0;
 const p=await fixture(async(n,b,f,res)=>{if(n===1){f({content:'Partial'});ready.resolve();await new Promise(r=>res.once('close',r));}else done(b,f,res);});
 try{
  const s=new InteractiveSession({id:'drain',objective:'Resume after native cancel'},config(root,p.url),{...opts,fetchFn:async(url,options)=>{if(draining&&url.endsWith('/slots')){draining--;return Response.json([{id:0,is_processing:true}]);}return fetch(url,options);}});
  const work=s.runSlice();await ready.promise;s.pause();await work;draining=2;assert.equal((await s.runSlice()).status,'awaiting_input');assert.equal(draining,0);assert.equal(generations(p).length,2);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('idle Compact restores the stable system and all tools before replaying a persisted Pi tool-definition update',async()=>{
 const root=temp();const p=await fixture(async(n,b,f,res)=>done(b,f,res,b.response_format?summary():'Ready'));
 try{
  const s=new InteractiveSession({id:'system-delta',objective:'Keep the complete system prefix'},config(root,p.url),opts);await s.runSlice();
  const read=s.tools().find(t=>t.name==='read');s.store.append('message',{role:'system',content:'',timestamp:Date.now(),toolsAdded:[{name:read.name,description:read.description,parameters:read.parameters}],toolsRemoved:[{name:'read'}]});
  s.requestCompact();await s.runSlice({maintenanceOnly:true});const compact=generations(p).find(b=>b.response_format);assert.ok(compact);assert.match(compact.messages[0].content,/persistent interactive competition session/);assert.ok(compact.tools.some(t=>t.function.name==='run_command'));assert.ok(compact.tools.some(t=>t.function.name==='read'));assert.ok(compact.tools.length>1);
 }finally{await p.close();fs.rmSync(root,{recursive:true,force:true});}
});
