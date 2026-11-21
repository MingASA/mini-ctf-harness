import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {Contest} from '../src/contest.mjs';
import {TeamTransport} from '../src/team-transport.mjs';
import {BtwSession} from '../src/btw-session.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await sleep(10);}throw Error('Condition not reached');}
const tokens=b=>Math.ceil(JSON.stringify({messages:b.messages,tools:b.tools}).length/4);
async function model(t,script){
 let n=0;const requests=[];
 const server=http.createServer(async(req,res)=>{try{
  if(req.method==='GET'){res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/slots'?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:40000}}));return;}
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests.push({route:req.url,body});
  if(req.url.endsWith('input_tokens')){res.end(JSON.stringify({input_tokens:tokens(body)}));return;}
  res.setHeader('content-type','text/event-stream');res.flushHeaders();
  const frame=(delta,finish_reason)=>res.write('data: '+JSON.stringify({choices:[{delta,finish_reason}],usage:finish_reason?{prompt_tokens:tokens(body),completion_tokens:10,total_tokens:tokens(body)+10}:undefined})+'\n\n');
  await script(++n,body,frame);res.end('data: [DONE]\n\n');
 }catch(e){res.destroy(e);}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return {url:'http://127.0.0.1:'+server.address().port,requests};
}
const say=(frame,text)=>frame({content:text},'stop');
const call=(frame,name,args,id)=>frame({tool_calls:[{index:0,id:id??'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctf-team-')),nodes=[],cleanups=[];t.after(async()=>{for(const cleanup of cleanups)await cleanup();for(const c of nodes.reverse())await c.close();fs.rmSync(root,{recursive:true,force:true});});
 async function node(name,url='http://127.0.0.1:1',config={}){
  const cfg={contestDir:path.join(root,name),model:{baseUrl:url,contextTokens:40000,promptTokens:26000,generationTokens:1024,reasoningTokens:512,maxSeconds:30,maxTurns:100,maxGeneratedTokens:50000},team:{secret:'test-team-secret',host:'127.0.0.1',port:0,discovery:false,retryMs:25,timeoutMs:500,...config}};
  const options={testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,name,'work',id);fs.mkdirSync(workDir,{recursive:true});return {workDir,containerId:name+'-'+id};},sessionOptions:()=>({knowledge:{docs:[],search:()=>[]},broker:{validate:async()=>{},checkCommand:()=>{}}})};
  const c=new Contest(cfg,options);nodes.push(c);await c.enableTeam();return c;
 }
 return {root,nodes,node,cleanups};
}
async function pair(f){
 const c=await f.node('center'),w=await f.node('worker');await c.add({id:'challenge',objective:'Synthetic challenge'});await c.team.center('challenge');w.team.worker();await c.team.connect('challenge',w.team.transport.url);await until(()=>w.team.state.bindings.length===1);return {c,w,cb:c.team.binding('challenge'),wb:w.team.state.bindings[0]};
}

test('HTTP routes tasks and simultaneous reports to exact sessions; explicit pause and scheduler stop survive arrivals',async t=>{
 const f=fixture(t),{c,w,cb,wb}=await pair(f);await c.add({id:'unrelated',objective:'Unrelated solo challenge'});
 c.queue.settle('challenge','awaiting_input');w.queue.settle(wb.taskId,'awaiting_input');
 c.team.send(cb,'task','Inspect parser',1,'assignment');await until(()=>w.session(wb.taskId).inbox.items().some(i=>i.id==='team-assignment'));
 assert.equal(w.status(wb.taskId),'ready_resume');assert.equal(w.enabled,false);assert.equal(c.session('unrelated').inbox.items().length,0);
 w.queue.settle(wb.taskId,'paused');c.team.send(cb,'task','New guidance',1,'guidance');await until(()=>w.session(wb.taskId).inbox.items().some(i=>i.id==='team-guidance'));assert.equal(w.status(wb.taskId),'paused');
 const envelope={recipientId:c.team.transport.id,teamId:cb.teamId,kind:'help',text:'Observed blocker',from:w.team.transport.self()};
 await Promise.all(Array.from({length:8},(_,i)=>w.team.transport.request(c.team.transport.url,'/message',{...envelope,id:'report-'+i})));
 assert.equal(c.session('challenge').inbox.items().filter(i=>i.id.startsWith('team-report-')).length,8);assert.equal(c.status('challenge'),'ready_resume');
 await w.team.transport.request(c.team.transport.url,'/message',{...envelope,id:'report-0'});
 assert.equal(c.session('challenge').inbox.items().filter(i=>i.id==='team-report-0').length,1);
 await assert.rejects(w.team.transport.request(c.team.transport.url,'/message',{...envelope,id:'report-0',text:'different'}),/reused/);
 await assert.rejects(w.team.transport.request(c.team.transport.url,'/message',{...envelope,id:'wrong-team',teamId:'elsewhere'}),/Unknown team/);
 await assert.rejects(w.team.transport.request(c.team.transport.url,'/message',{...envelope,id:'bad-role',kind:'task'}),/kind/);
 const noAuth=await fetch(c.team.transport.url+'/info');assert.equal(noAuth.status,401);
});

test('graph, paged original evidence and binary files stay within the bound challenge',async t=>{
 const f=fixture(t),{c,w,cb,wb}=await pair(f);
 c.team.updateGraph(cb,'F1: parser rejects invalid CRC [worker 1 artifact abc]','I1: inspect CRC coverage based on F1');
 assert.match((await w.team.remoteRead(wb,{source:'graph'})).facts,/F1/);
 assert.throws(()=>w.team.updateGraph(wb,'fake','fake'),/Only Center/);
 const ws=w.session(wb.taskId);for(let i=0;i<3;i++)ws.store.append('message',{role:'assistant',content:[{type:'text',text:'observed '+i}]});
 const first=await c.team.remoteRead(cb,{worker:1,source:'messages',limit:2});assert.equal(first.items.length,2);assert.equal(first.next_offset,2);
 assert.equal((await c.team.remoteRead(cb,{worker:1,source:'messages',offset:2,limit:2})).items.length,1);
 const evidence=ws.store.put('a'.repeat(20000),'tool:read');assert.equal((await c.team.remoteRead(cb,{worker:1,source:'artifact',ref:evidence.id,limit:20000})).text.length,20000);
 const bytes=Buffer.from([0,1,255,0,42]);fs.writeFileSync(path.join(ws.config.sandbox.workDir,'sample.bin'),bytes);
 const saved=await c.team.remoteRead(cb,{worker:1,source:'file',ref:'/work/sample.bin'},'fetch-sample');assert.deepEqual(fs.readFileSync(path.join(c.session('challenge').config.sandbox.workDir,saved.path.slice(6))),bytes);
 fs.symlinkSync('/etc/passwd',path.join(ws.config.sandbox.workDir,'escape'));
 await assert.rejects(c.team.remoteRead(cb,{worker:1,source:'file',ref:'/work/escape'},'escape'),/escapes/);
 await assert.rejects(c.team.remoteRead(cb,{worker:1,source:'file',ref:'/work/../../etc/passwd'},'traverse'));
 await assert.rejects(w.team.remoteRead(wb,{worker:'2',source:'messages'}),/only with Center/);
});

test('durable outbox replays after restart and an applied-but-unacknowledged inbox deduplicates',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'team-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config={secret:'same',host:'127.0.0.1',port:0,discovery:false,retryMs:20,timeoutMs:100};let applied=0;const seen=new Set();let crash=true;
 const receiver=new TeamTransport(path.join(root,'receiver'),config,{receive:async m=>{if(!seen.has(m.id)){seen.add(m.id);applied++;}if(crash){crash=false;throw Error('simulated crash before receipt');}return {ok:true};}});await receiver.start();t.after(()=>receiver.close());
 let sender=new TeamTransport(path.join(root,'sender'),config,{receive:()=>({})});await sender.start();const id=sender.id;
 sender.queue({...receiver.self(),url:'http://127.0.0.1:1'},{id:'durable',teamId:'challenge',kind:'help',text:'facts'});await sleep(30);assert.equal(sender.pending().length,1);await sender.close();
 sender=new TeamTransport(path.join(root,'sender'),config,{receive:()=>({})});t.after(()=>sender.close());await sender.start();assert.equal(sender.id,id);sender.relocate(receiver.self());await until(()=>sender.pending().length===0);assert.equal(applied,1);
 assert.equal(receiver.store.events.filter(e=>e.type==='received').length,1);
});

test('real Pi sessions complete Center graph/assignment -> Worker help -> Center correction -> Worker finish',async t=>{
 const cm=await model(t,async(n,b,frame)=>{
  if(n===1)call(frame,'team_graph',{action:'update',facts:'F1: fixture checksum mismatch',intents:'I1: Worker 1 inspect coverage based on F1'});
  else if(n===2)call(frame,'team_message',{action:'send',worker:'1',kind:'task',text:'Inspect checksum coverage based on F1'},'assign');
  else if(n===3)say(frame,'Waiting for evidence.');
  else if(n===4){assert.match(JSON.stringify(b.messages),/blocker/);call(frame,'team_message',{action:'send',worker:'1',kind:'task',text:'Check whether length field is included'},'correct');}
  else say(frame,'Integrated results.');
 });
 const wm=await model(t,async(n,b,frame)=>{
  if(n===1)call(frame,'team_message',{action:'send',kind:'help',text:'blocker: payload-only CRC failed; evidence /work/check.txt'},'ask-help');
  else {assert.match(JSON.stringify(b.messages),/length field/);call(frame,'team_message',{action:'send',kind:'finish',text:'Observed length field included; fixture validated'},'finish');}
 });
 const f=fixture(t),c=await f.node('center',cm.url),w=await f.node('worker',wm.url);
 await c.add({id:'challenge',objective:'Find checksum coverage'});await c.team.center('challenge');w.team.worker();await c.team.connect('challenge',w.team.transport.url);await until(()=>w.team.state.bindings.length===1);
 const wb=w.team.state.bindings[0];c.enabled=true;w.enabled=true;await c.tick();assert.equal(c.status('challenge'),'awaiting_input');
 await until(()=>w.session(wb.taskId).inbox.items().some(i=>i.text.includes('Inspect checksum coverage')));await w.tick();assert.equal(w.status(wb.taskId),'awaiting_input');
 await until(()=>c.status('challenge')==='ready_resume');await c.tick();await until(()=>w.status(wb.taskId)==='ready_resume');await w.tick();await until(()=>c.status('challenge')==='ready_resume');await c.tick();
 assert.equal(c.status('challenge'),'awaiting_input');assert.match(c.team.graph(c.team.binding('challenge')).intents,/F1/);
 assert.match(c.session('challenge').systemPrompt(),/CENTER/);assert.match(w.session(wb.taskId).systemPrompt(),/WORKER/);
 assert.ok(c.session('challenge').tools().some(x=>x.name==='run_command'));assert.equal(wm.requests.filter(x=>x.route==='/v1/chat/completions').length,2);
 const branch=BtwSession.create(c.session('challenge'));assert.ok(!branch.tools().some(x=>x.name.startsWith('team_')));const branchHistory=JSON.stringify(branch.data.history);
 w.team.send(wb,'help','Second blocker',undefined,'later-help');await until(()=>c.session('challenge').inbox.items().some(i=>i.id==='team-later-help'));assert.equal(JSON.stringify(branch.data.history),branchHistory);
});

test('handoff waits for the in-flight turn, delivers its directive, forwards only final report, then waits',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const wm=await model(t,async(n,b,frame)=>{if(n===1){frame({content:'ordinary exploration'});entered();await gate;say(frame,' old final');}else{assert.match(JSON.stringify(b.messages),/Operator requests handoff/);say(frame,'Observed fact: magic bytes PNG; no exploit demonstrated.');}});
 const f=fixture(t),c=await f.node('center'),w=await f.node('worker',wm.url);await c.add({id:'challenge',objective:'fixture'});await c.team.center('challenge');w.team.worker();await c.team.connect('challenge',w.team.transport.url);await until(()=>w.team.state.bindings.length===1);
 const wb=w.team.state.bindings[0];w.enabled=true;const running=w.tick();await started;w.team.requestReport(wb.taskId,'handoff');release();await running;
 assert.equal(w.status(wb.taskId),'ready_resume');assert.equal(w.team.transport.store.events.filter(e=>e.type==='outgoing'&&e.data.message.kind==='handoff').length,0);
 await w.tick();assert.equal(w.status(wb.taskId),'awaiting_input');await until(()=>c.session('challenge').inbox.items().some(i=>i.text.includes('Observed fact: magic bytes PNG')));
 const reports=w.team.transport.store.events.filter(e=>e.type==='outgoing'&&e.data.message.kind==='handoff');assert.equal(reports.length,1);assert.doesNotMatch(reports[0].data.message.text,/old final/);
});

test('startup replay and live retries share one receive queue even while provisioning awaits',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'team-start-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let entered,release,calls=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const config={secret:'same',host:'127.0.0.1',port:0,discovery:false};
 const transport=new TeamTransport(root,config,{receive:async()=>{calls++;entered();await gate;return {ok:true};}});t.after(()=>transport.close());
 const message={recipientId:transport.id,id:'recover',teamId:'fixture',from:{id:'peer',url:'http://127.0.0.1:1'}};
 const {hash}=await import('../src/store.mjs');transport.store.append('incoming',{message,digest:hash(JSON.stringify(message))});
 const starting=transport.start();await started;const retry=transport.request(transport.url,'/message',message);await sleep(30);assert.equal(calls,1);release();await Promise.all([starting,retry]);assert.equal(calls,1);
});

test('an old tool reply cannot consume an undelivered handoff; a node can join subsequent challenges',async t=>{
 const f=fixture(t),{c,w,wb}=await pair(f),s=w.session(wb.taskId);
 const pending=w.team.requestReport(wb.taskId,'handoff');
 await s.tools().find(x=>x.name==='team_message').execute('old-turn-help',{action:'send',kind:'help',text:'old request'});
 assert.equal(w.team.pendingReport(wb).id,pending.id);assert.equal(s.inbox.items().find(i=>i.id===pending.id).status,'queued');
 s.inbox.accepted({requestId:'next-turn',inboxIds:s.inbox.items().map(i=>i.id)});assert.equal(w.team.finishTurn(wb.taskId,{stopReason:'tool_calls',content:[]}),false);assert.equal(w.team.pendingReport(wb).id,pending.id);
 await c.add({id:'second',objective:'Second independent challenge'});await c.team.center('second');w.team.worker();await c.team.connect('second',w.team.transport.url);await until(()=>w.team.state.bindings.length===2);
 assert.notEqual(w.team.state.bindings[0].taskId,w.team.state.bindings[1].taskId);
 assert.ok(c.session('challenge').inbox.items().some(i=>i.text.includes('has joined')));
});

test('paused file transfer cancels promptly without a size cap, and directory replacement cannot escape /work',async t=>{
 const f=fixture(t),{c,w,cb,wb}=await pair(f);let stream;
 const {PassThrough}=await import('node:stream');
 w.team.transport.read=async()=>{stream=new PassThrough();stream.write('partial');return {stream};};
 const controller=new AbortController(),tool=c.session('challenge').tools().find(x=>x.name==='team_read');
 const running=tool.execute('cancel-transfer',{worker:'1',source:'file',ref:'/work/slow'},controller.signal);await until(()=>Boolean(stream));controller.abort();
 const cancelled=await running;assert.equal(cancelled.isError,true);assert.equal(c.session('challenge').store.pending().length,0);assert.ok(!fs.readdirSync(c.team.root).some(n=>n.endsWith('.download')));
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 w.team.transport.read=async()=>{entered();await gate;return {stream:fs.createReadStream(path.join(w.session(wb.taskId).config.sandbox.workDir,'sample'))};};
 fs.writeFileSync(path.join(w.session(wb.taskId).config.sandbox.workDir,'sample'),'evidence');
 const work=c.session('challenge').config.sandbox.workDir,outside=path.join(f.root,'outside');fs.mkdirSync(outside);
 const transfer=c.team.remoteRead(cb,{worker:1,source:'file',ref:'/work/sample'},'race');await started;
 fs.rmSync(path.join(work,'team-import'),{recursive:true});fs.symlinkSync(outside,path.join(work,'team-import'));release();await assert.rejects(transfer);assert.deepEqual(fs.readdirSync(outside),[]);
});

test('discovery finds listening opted-in peers, while manual HTTP remains independent',async t=>{
 const receiver=new TeamTransport(fs.mkdtempSync(path.join(os.tmpdir(),'team-discovery-')),{secret:'same',host:'127.0.0.1',port:0,discoveryPort:0},{receive:()=>({}),info:()=>({ready:true})});
 t.after(async()=>{await receiver.close();fs.rmSync(receiver.store.root,{recursive:true,force:true});});await receiver.start();
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'team-finder-'));const sender=new TeamTransport(root,{secret:'same',host:'127.0.0.1',port:0,discovery:false,discoveryPort:receiver.discovery.address().port,broadcastAddress:'127.0.0.1',discoveryMs:30},{receive:()=>({})});
 t.after(async()=>{await sender.close();fs.rmSync(root,{recursive:true,force:true});});await sender.start();
 const peers=await sender.discover();assert.equal(peers.length,1);assert.equal(peers[0].id,receiver.id);assert.equal(peers[0].ready,true);
 assert.equal((await sender.request(peers[0].url,'/info')).id,receiver.id);
});

test('arbitrary worker count, persisted bindings and completed join receipts do not spuriously wake on reopen',async t=>{
 const f=fixture(t),c=await f.node('center');await c.add({id:'challenge',objective:'parallel fixture'});await c.team.center('challenge');
 const workers=await Promise.all(['one','two','three'].map(name=>f.node(name)));for(const w of workers)w.team.worker();
 for(const w of workers)await c.team.connect('challenge',w.team.transport.url);
 await until(()=>workers.every(w=>w.team.state.bindings.length===1)&&c.team.transport.pending().length===0);
 assert.deepEqual(c.team.binding('challenge').workers.map(w=>w.number),[1,2,3]);
 for(let i=0;i<workers.length;i++)c.team.send(c.team.binding('challenge'),'task','unique direction '+i,String(i+1),'direction-'+i);
 await until(()=>workers.every((w,i)=>w.session(w.team.state.bindings[0].taskId).inbox.items().some(x=>x.text.includes('unique direction '+i))));
 for(let i=0;i<workers.length;i++)assert.equal(workers[i].session(workers[i].team.state.bindings[0].taskId).inbox.items().filter(x=>x.text.includes('unique direction')).length,1);
 const s=c.session('challenge');s.inbox.accepted({requestId:'fixture',inboxIds:s.inbox.items().map(i=>i.id)});c.queue.settle('challenge','awaiting_input');
 await c.enableTeam();assert.equal(c.status('challenge'),'awaiting_input');
 const config=structuredClone(c.config);config.team.port=c.team.transport.server.address().port;await c.close();
 const reopened=new Contest(config,c.options);f.nodes.push(reopened);await reopened.enableTeam();assert.equal(reopened.team.binding('challenge').workers.length,3);assert.equal(reopened.status('challenge'),'awaiting_input');
 const w=workers[0],wb=w.team.state.bindings[0];w.team.send(wb,'help','after Center restart',undefined,'restart-report');await until(()=>reopened.status('challenge')==='ready_resume');assert.ok(reopened.session('challenge').inbox.items().some(i=>i.text.includes('after Center restart')));
});

test('TUI selects a remote-created Worker session, returns actions to output, and preserves multiline scouting reports',async t=>{
 const {CompetitionTerminal}=await import('../src/terminal.mjs');
 class Terminal {columns=110;rows=30;kittyProtocolActive=false;start(){}stop(){}write(){}drainInput(){return Promise.resolve();}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}
 const f=fixture(t),c=await f.node('center'),w=await f.node('worker'),ui=new CompetitionTerminal(w,{terminal:new Terminal()});f.cleanups.push(()=>ui.close());
 await ui.submit('/team worker new');assert.equal(ui.detail,null);assert.equal(ui.tab,'output');
 await c.add({id:'challenge',objective:'fixture'});await c.team.center('challenge');await c.team.connect('challenge',w.team.transport.url);await until(()=>w.team.state.bindings.length===1);
 const taskId=w.team.state.bindings[0].taskId;assert.equal(ui.selected,taskId);assert.equal(ui.bound,taskId);
 await ui.submit('/team');assert.ok(ui.detail);await ui.submit('/help need parser advice');assert.equal(ui.detail,null);assert.equal(ui.tab,'output');assert.equal(w.team.pendingReport(w.team.binding(taskId)).kind,'help');
 await ui.submit('/help commands');assert.match(ui.detail,/快捷键|Ctrl\+N/);
 let input;ui.dialog=(_title,component)=>{input=component;return ()=>{};};
 const report=ui.multilineValue('Report');input.handleInput('\x1b[200~F1: observed header\nF2: checksum failed\x1b[201~');input.handleInput('\r');assert.equal(await report,'F1: observed header\nF2: checksum failed');
});

test('a real Pi team_read file call is interruptible by ordinary session pause',async t=>{
 const cm=await model(t,async(_n,_b,frame)=>call(frame,'team_read',{worker:'1',source:'file',ref:'/work/slow'},'slow-file'));
 const f=fixture(t),c=await f.node('center',cm.url),w=await f.node('worker');await c.add({id:'challenge',objective:'fixture'});await c.team.center('challenge');w.team.worker();await c.team.connect('challenge',w.team.transport.url);await until(()=>w.team.state.bindings.length===1);
 let stream;const {PassThrough}=await import('node:stream');w.team.transport.read=async()=>{stream=new PassThrough();stream.write('chunk');return {stream};};
 c.enabled=true;const running=c.tick();await until(()=>Boolean(stream));c.pause('challenge');await running;
 assert.equal(c.status('challenge'),'paused');assert.equal(c.session('challenge').store.pending().length,0);assert.ok(!fs.readdirSync(c.team.root).some(n=>n.endsWith('.download')));
});

test('a reused LAN address cannot accept an invitation intended for a different node',async t=>{
 const f=fixture(t),c=await f.node('center'),w=await f.node('worker');w.team.worker();
 c.team.transport.queue({...w.team.transport.self(),id:'different-node'},{id:'wrong-recipient',teamId:'fixture',kind:'invite',text:'Must not run here'});
 await until(()=>c.team.transport.errors.size>0);assert.equal(w.team.state.bindings.length,0);assert.equal(w.records.size,0);assert.equal(c.team.transport.pending().length,1);assert.equal(w.team.transport.store.events.filter(e=>e.type==='incoming').length,0);
});

test('an unavailable old team does not block a new challenge on the same worker',async t=>{
 const f=fixture(t),{c,w,cb,wb}=await pair(f);w.team.forgetTask(wb.taskId);
 c.team.send(cb,'task','old direction',1,'stale-team');await until(()=>c.team.transport.errors.size>0);
 await c.add({id:'new_challenge',objective:'New independent challenge'});await c.team.center('new_challenge');w.team.worker();await c.team.connect('new_challenge',w.team.transport.url);
 await until(()=>Boolean(w.team.byTeam(c.team.binding('new_challenge').teamId)));assert.ok(c.team.transport.pending().some(x=>x.message.id==='stale-team'));
});

test('new Worker provisioning receives the LAN target and shutdown cancels a pending invitation',async t=>{
 const f=fixture(t),c=await f.node('center'),w=await f.node('worker');await c.add({id:'challenge',objective:'Reach target',target:'http://192.168.50.90:31337'});await c.team.center('challenge');w.team.worker();
 let args;w.options.provision=async(_id,options)=>{args=options;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));};
 await c.team.connect('challenge',w.team.transport.url);await until(()=>Boolean(args));assert.equal(args.target,'http://192.168.50.90:31337');
 await w.close();assert.equal(args.signal.aborted,true);assert.equal(w.records.size,0);assert.equal(w.team.state.bindings.length,0);
});
