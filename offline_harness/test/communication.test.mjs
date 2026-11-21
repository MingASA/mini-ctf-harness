import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {Contest} from '../src/contest.mjs';
import {CommunicationTransport} from '../src/communication-transport.mjs';
import {BtwSession} from '../src/btw-session.mjs';
import {hash} from '../src/store.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(10);}throw Error('Condition not reached');}
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
const send=(frame,message,id='peer-call')=>frame({tool_calls:[{index:0,id,type:'function',function:{name:'communicate',arguments:JSON.stringify({message})}}]},'tool_calls');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ctf-communication-')),nodes=[],cleanups=[];
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();for(const c of nodes.reverse())await c.close();fs.rmSync(root,{recursive:true,force:true});});
 async function node(name,url='http://127.0.0.1:1',network={}){
  const cfg={contestDir:path.join(root,name),model:{baseUrl:url,contextTokens:40000,promptTokens:26000,generationTokens:1024,reasoningTokens:512,maxSeconds:30,maxTurns:100,maxGeneratedTokens:50000},communicate:{name,secret:'test-secret',host:'127.0.0.1',port:0,retryMs:25,timeoutMs:150,...network}};
  const options={testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,name,'work',id);fs.mkdirSync(workDir,{recursive:true});return {workDir,containerId:name+'-'+id};},sessionOptions:()=>({knowledge:{docs:[],search:()=>[]},broker:{validate:async()=>{},checkCommand:()=>{}}})};
  const c=new Contest(cfg,options);nodes.push(c);await c.enableCommunication();return c;
 }
 return {root,nodes,cleanups,node};
}
async function pair(f){
 const a=await f.node('a'),b=await f.node('b');await a.add({id:'one',objective:'Challenge A'});await b.add({id:'one',objective:'Challenge B'});
 b.communication.open('one');await a.communication.connect('one',b.communication.transport.url,b.communication.binding('one').sessionId);return {a,b};
}
function envelope(a,text,id='msg'){const b=a.communication.binding('one');return {id,from:a.communication.route(b),to:b.peer,text};}

test('pairing is explicit, session-specific, symmetric, authenticated and separate from ordinary tools',async t=>{
 const f=fixture(t),a=await f.node('a'),b=await f.node('b');await a.add({id:'one',objective:'A'});await b.add({id:'one',objective:'B'});await b.add({id:'other',objective:'Unrelated'});
 assert.ok(!a.session('one').tools().some(t=>t.name==='communicate'));assert.equal(a.communication.exports().length,0);
 await assert.rejects(a.communication.connect('one',b.communication.transport.url,'one'),/not open/);
 const opened=b.communication.open('one');await a.communication.connect('one',b.communication.transport.url,opened.session.code);
 assert.ok(a.session('one').tools().some(t=>t.name==='communicate'));assert.ok(b.session('one').tools().some(t=>t.name==='communicate'));assert.ok(!b.session('other').tools().some(t=>t.name==='communicate'));
 const response=await fetch(b.communication.transport.url+'/info');assert.equal(response.status,401);
 assert.ok(!JSON.stringify(a.communication.status('one')).includes('test-secret'));
 a.communication.send('one','Can you check the parser?','question');await until(()=>b.session('one').inbox.items().some(i=>i.id==='communicate-question'));
 b.communication.send('one','Observed CRC mismatch.','answer');await until(()=>a.session('one').inbox.items().some(i=>i.id==='communicate-answer'));
 assert.equal(b.session('other').inbox.items().length,0);assert.equal(a.enabled,false);assert.equal(b.enabled,false);
});

test('concurrent delivery deduplicates and rejects wrong sessions, node IDs and reused message contents',async t=>{
 const f=fixture(t),{a,b}=await pair(f);b.queue.settle('one','awaiting_input');
 const m=envelope(a,'Observed fact','concurrent');await Promise.all(Array.from({length:5},()=>a.communication.transport.request(b.communication.transport.url,'/message',m)));
 assert.equal(b.session('one').inbox.items().filter(i=>i.id==='communicate-concurrent').length,1);assert.equal(b.status('one'),'ready_resume');
 await assert.rejects(a.communication.transport.request(b.communication.transport.url,'/message',{...m,text:'changed'}),/reused/);
 await assert.rejects(a.communication.transport.request(b.communication.transport.url,'/message',{...m,id:'wrong-node',to:{...m.to,nodeId:'other'}}),/different node/);
 await assert.rejects(a.communication.transport.request(b.communication.transport.url,'/message',{...m,id:'wrong-session',to:{...m.to,sessionId:'one'}}),/closed or replaced/);
 await assert.rejects(a.communication.transport.request(b.communication.transport.url,'/message',{...m,id:'wrong-sender',from:{...m.from,sessionId:'unpaired'}}),/not paired/);
});

test('human pause, review and stopped scheduling are not overridden; long peer messages have no new cap',async t=>{
 const f=fixture(t),{a,b}=await pair(f);
 for(const state of ['paused','needs_review','budget_exhausted','correct']){
  b.queue.settle('one',state);a.communication.send('one','message for '+state,'state-'+state);await until(()=>b.session('one').inbox.items().some(i=>i.id==='communicate-state-'+state));assert.equal(b.status('one'),state);
 }
 b.queue.settle('one','awaiting_input');a.communication.send('one','x'.repeat(20000),'long');await until(()=>b.session('one').inbox.items().some(i=>i.id==='communicate-long'));assert.equal(b.status('one'),'ready_resume');assert.equal(b.enabled,false);
});

test('offline outbox and peer bindings survive restart and deliver once after reconnection',async t=>{
 const f=fixture(t),{a,b}=await pair(f),aConfig=structuredClone(a.config),bConfig=structuredClone(b.config);
 aConfig.communicate.port=a.communication.transport.server.address().port;bConfig.communicate.port=b.communication.transport.server.address().port;
 const oldNode=a.communication.transport.id,oldSession=a.communication.binding('one').sessionId;
 await b.close();a.communication.send('one','retained through disconnection','durable');await until(()=>a.communication.transport.errors.size>0);assert.equal(a.communication.transport.delivery('durable').status,'queued');await a.close();
 const a2=new Contest(aConfig,a.options);f.nodes.push(a2);await a2.enableCommunication();assert.equal(a2.communication.transport.id,oldNode);assert.equal(a2.communication.binding('one').sessionId,oldSession);
 const b2=new Contest(bConfig,b.options);f.nodes.push(b2);await b2.enableCommunication();await until(()=>a2.communication.transport.delivery('durable').status==='delivered');assert.equal(b2.session('one').inbox.items().filter(i=>i.id==='communicate-durable').length,1);
 assert.equal(b2.enabled,false);
});

test('a lost delivery acknowledgement retries without injecting a second message',async t=>{
 const f=fixture(t),{a,b}=await pair(f);const original=a.communication.transport.request.bind(a.communication.transport);let lose=true;
 a.communication.transport.request=async(...args)=>{const response=await original(...args);if(args[1]==='/message'&&lose){lose=false;throw Error('connection lost after peer commit');}return response;};
 a.communication.send('one','exactly once in the inbox','lost-ack');await until(()=>a.communication.transport.delivery('lost-ack').status==='delivered');assert.equal(b.session('one').inbox.items().filter(i=>i.id==='communicate-lost-ack').length,1);
});

test('disconnect cancels queued sends and stale tools cannot send to a newly paired session',async t=>{
 const f=fixture(t),{a,b}=await pair(f),stale=a.session('one').tools().find(t=>t.name==='communicate'),old=a.communication.binding('one').sessionId;
 await b.close();a.communication.send('one','cancel me','cancelled');a.communication.off('one');assert.equal(a.communication.transport.delivery('cancelled').status,'cancelled');assert.equal(a.communication.tools('one').length,0);
 a.communication.open('one');assert.notEqual(a.communication.binding('one').sessionId,old);
 const response=await stale.execute('stale-call',{message:'must not send'});assert.equal(response.isError,true);assert.equal(a.session('one').store.pending().length,0);
});

test('a closed old conversation does not block another paired conversation on the same peer',async t=>{
 const f=fixture(t),{a,b}=await pair(f);b.communication.off('one');a.communication.send('one','stale destination','old');
 await a.add({id:'two',objective:'Next A'});await b.add({id:'two',objective:'Next B'});b.communication.open('two');await a.communication.connect('two',b.communication.transport.url,b.communication.binding('two').sessionId);a.communication.send('two','new conversation','new');
 await until(()=>a.communication.transport.delivery('old').status==='failed'&&a.communication.transport.delivery('new').status==='delivered');assert.ok(b.session('two').inbox.items().some(i=>i.id==='communicate-new'));
});

test('startup replay and network retries share a serialized inbox',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'comm-replay-'));let release,entered,count=0;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const transport=new CommunicationTransport(root,{secret:'secret',host:'127.0.0.1',port:0,retryMs:20},{info:()=>[],pair:()=>({}),validate:()=>{},receive:async()=>{count++;entered();await gate;return {accepted:true};}});
 t.after(async()=>{release();await transport.close();fs.rmSync(root,{recursive:true,force:true});});
 const m={id:'recover',from:{nodeId:'sender',sessionId:'sender-session',url:'http://127.0.0.1:1'},to:{nodeId:transport.id,sessionId:'receiver-session'},text:'durable'};
 transport.store.append('incoming',{message:m,digest:hash(JSON.stringify(m))});const starting=transport.start();await started;const retry=transport.request(transport.url,'/message',m);await sleep(30);assert.equal(count,1);release();await Promise.all([starting,retry]);assert.equal(count,1);
});

test('real Pi agents exchange messages through communicate and wake the correct waiting session',async t=>{
 const am=await model(t,async(n,b,f)=>{if(n===1)send(f,'Please independently check CRC coverage');else if(n===2)say(f,'Waiting for the peer.');else{assert.match(JSON.stringify(b.messages),/length is covered/);say(f,'I will verify that observation.');}});
 const bm=await model(t,async(n,b,f)=>{if(n===1){assert.match(JSON.stringify(b.messages),/independently check/);send(f,'Observed: length is covered by CRC','reply');}else say(f,'Local result retained.');});
 const f=fixture(t),a=await f.node('a',am.url),b=await f.node('b',bm.url);await a.add({id:'one',objective:'A'});await b.add({id:'one',objective:'B'});b.communication.open('one');await a.communication.connect('one',b.communication.transport.url,b.communication.binding('one').sessionId);
 a.enabled=true;b.enabled=true;await a.tick();assert.equal(a.status('one'),'awaiting_input');await until(()=>b.session('one').inbox.items().length===1);await b.tick();await until(()=>a.status('one')==='ready_resume');await a.tick();assert.equal(a.status('one'),'awaiting_input');
 assert.ok(a.session('one').inbox.items().some(i=>i.status==='delivered'));assert.equal(am.requests.filter(r=>r.route==='/v1/chat/completions').length,3);
 const branch=BtwSession.create(a.session('one'));assert.ok(!branch.tools().some(t=>t.name==='communicate'));assert.match(branch.requestBody().messages.at(-1).content,/cannot call communicate/);
 const history=JSON.stringify(branch.data.history);b.communication.send('one','another observation','later');await until(()=>a.session('one').inbox.items().some(i=>i.id==='communicate-later'));assert.equal(JSON.stringify(branch.data.history),history);
});

test('a peer message arriving during generation enters the next request rather than a second concurrent run',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const am=await model(t,async(n,b,f)=>{if(n===1){f({content:'Working'});entered();await gate;}else assert.match(JSON.stringify(b.messages),/new evidence mid-stream/);say(f,'Complete '+n);});
 const f=fixture(t),a=await f.node('a',am.url),b=await f.node('b');await a.add({id:'one',objective:'A'});await b.add({id:'one',objective:'B'});b.communication.open('one');await a.communication.connect('one',b.communication.transport.url,b.communication.binding('one').sessionId);
 a.enabled=true;const running=a.tick();await started;b.communication.send('one','new evidence mid-stream','mid');await until(()=>a.session('one').inbox.items().length===1);assert.equal(a.status('one'),'running');release();await running;assert.equal(a.status('one'),'awaiting_input');assert.equal(am.requests.filter(r=>r.route==='/v1/chat/completions').length,2);
});

test('lost pairing acknowledgement can be retried and a new URL must retain the peer identity',async t=>{
 const f=fixture(t),a=await f.node('a'),b=await f.node('b');await a.add({id:'one',objective:'A'});await b.add({id:'one',objective:'B'});const code=b.communication.open('one').session.code;
 const request=a.communication.transport.request.bind(a.communication.transport);let lose=true;
 a.communication.transport.request=async(...args)=>{const response=await request(...args);if(args[1]==='/pair'&&lose){lose=false;throw Error('lost pair ack');}return response;};
 await assert.rejects(a.communication.connect('one',b.communication.transport.url,code),/lost pair ack/);assert.equal(b.communication.binding('one').confirmed,true);assert.ok(!a.communication.binding('one').confirmed);
 await a.communication.connect('one',b.communication.transport.url,code);assert.equal(a.communication.binding('one').confirmed,true);
 const third=await f.node('third');await third.add({id:'one',objective:'Other machine'});const other=third.communication.open('one');await assert.rejects(a.communication.connect('one',third.communication.transport.url,other.session.code),/already paired/);
});

test('reconnecting after an address change resumes old pending messages without changing their identity',async t=>{
 const f=fixture(t),{a,b}=await pair(f),cfg=structuredClone(b.config),code=b.communication.binding('one').sessionId;
 await b.close();a.communication.send('one','queued for former URL','moving-peer');await until(()=>a.communication.transport.errors.size>0);
 const b2=new Contest(cfg,b.options);f.nodes.push(b2);await b2.enableCommunication();await a.communication.connect('one',b2.communication.transport.url,code);
 await until(()=>a.communication.transport.delivery('moving-peer').status==='delivered');assert.equal(b2.session('one').inbox.items().filter(i=>i.id==='communicate-moving-peer').length,1);
});

test('restart recovers a committed communicate outbox receipt without rerunning the tool',async t=>{
 const f=fixture(t),{a,b}=await pair(f),s=a.session('one'),cfg=structuredClone(a.config),callId='interrupted';
 const args={message:'durable tool message'},id=a.communication.messageId('one',callId);
 s.store.append('message',{role:'assistant',content:[{type:'toolCall',id:callId,name:'communicate',arguments:args}],stopReason:'toolUse'});
 s.store.append('tool_start',{callId,name:'communicate',args,identity:hash(JSON.stringify({name:'communicate',args}))});
 a.communication.send('one',args.message,id);await until(()=>a.communication.transport.delivery(id).status==='delivered');assert.equal(s.store.pending().length,1);await a.close();
 const a2=new Contest(cfg,a.options);f.nodes.push(a2);await a2.enableCommunication();assert.equal(a2.session('one').store.pending().length,0);
 const result=a2.session('one').store.events.findLast(e=>e.type==='message').data;assert.equal(result.toolCallId,callId);assert.equal(result.isError,false);
 assert.equal(a2.communication.transport.store.events.filter(e=>e.type==='outgoing').length,1);assert.equal(b.session('one').inbox.items().filter(i=>i.id==='communicate-'+id).length,1);
});

test('listener failure remains retryable and does not stop an unrelated single-agent session',async t=>{
 const f=fixture(t),first=await f.node('first'),port=first.communication.transport.server.address().port;
 const c=new Contest({...first.config,contestDir:path.join(f.root,'conflict'),communicate:{...first.config.communicate,port}},first.options);f.nodes.push(c);await c.add({id:'solo',objective:'Unrelated'});
 await assert.rejects(c.enableCommunication(),/EADDRINUSE/);assert.equal(c.communication.transport.server,undefined);assert.ok(!c.session('solo').tools().some(t=>t.name==='communicate'));
 await first.close();await c.enableCommunication();assert.ok(c.communication.transport.server);assert.equal(c.communication.status('solo').listener_error,undefined);
});

test('TUI pairs selected sessions, shows messages, and keeps /btw communication separate',async t=>{
 const {CompetitionTerminal}=await import('../src/terminal.mjs');
 class Terminal {columns=110;rows=30;kittyProtocolActive=false;start(){}stop(){}write(){}drainInput(){return Promise.resolve();}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}}
 const f=fixture(t),a=await f.node('a'),b=await f.node('b');await a.add({id:'one',objective:'A'});await b.add({id:'one',objective:'B'});
 const ui=new CompetitionTerminal(a,{terminal:new Terminal()});f.cleanups.push(()=>ui.close());const code=b.communication.open('one').session.code;
 await ui.submit('/communicate open');assert.match(ui.notice,/communicate connect/);assert.equal(ui.detail,null);
 await ui.submit('/communicate connect '+b.communication.transport.url+' '+code);assert.equal(ui.detail,null);
 await ui.submit('/communicate send Verify this observation');await until(()=>b.session('one').inbox.items().length===1);
 await ui.submit('/communicate messages');assert.match(ui.detail,/Verify this observation/);
 ui.btwFocused=true;await assert.rejects(ui.submit('/communicate send Wrong route'),/main/);ui.btwFocused=false;
 await ui.submit('/communicate off');assert.equal(a.communication.tools('one').length,0);assert.equal(ui.detail,null);
});

test('permanent delivery failure informs the originating agent once without waking a paused task',async t=>{
 const f=fixture(t),{a,b}=await pair(f);a.queue.settle('one','paused');b.communication.off('one');a.communication.send('one','old target','retired');
 await until(()=>a.communication.transport.delivery('retired').status==='failed');assert.equal(a.status('one'),'paused');
 assert.equal(a.session('one').inbox.items().filter(i=>i.id==='communicate-failed-retired').length,1);await a.enableCommunication();assert.equal(a.session('one').inbox.items().filter(i=>i.id==='communicate-failed-retired').length,1);
});
