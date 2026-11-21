import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Store,hash} from '../src/store.mjs';
import {BtwSession,snapshotBtw} from '../src/btw-session.mjs';
import {NativeClient} from '../src/native.mjs';
import {ModelCatalog} from '../src/model-catalog.mjs';
import {buildTools} from '../src/tools.mjs';

const frame=(delta,finish=null,usage=undefined)=>'data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage})+'\n\n';
const system='Retain the original system prompt and tools';
const tools=[{type:'function',function:{name:'read',description:'read',parameters:{type:'object',properties:{}}}}];
const branchToolSchema={type:'object',properties:{command:{type:'string',minLength:1,maxLength:1000}},required:['command'],additionalProperties:false};
function branchTool(root,branchId,calls,{wait,store:toolStore}={}){
 return {name:'run_command',description:'Run a local branch command.',parameters:branchToolSchema,execute:async(callId,args,signal)=>{
  const store=typeof toolStore==='function'?toolStore():toolStore??new Store(path.join(root,'btw-tools',branchId));
  return store.execute(callId,'run_command',args,async()=>{
   calls.push({callId,args});
   if(wait)await wait(signal);
   return {content:[{type:'text',text:JSON.stringify({branch:true,call_id:callId,command:args.command})}],details:{job_status:'finished'}};
  });
 }};
}
function session(t,url='http://127.0.0.1:1'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'btw-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root),task={id:'fixture'},config={model:'fixture',baseUrl:url,contextTokens:8192,generationTokens:128,safetyTokens:0,mode:'memory-skills'};
 return {task,config,store,messages:()=>store.events.filter(e=>e.type==='message').map(e=>e.data)};
}
function accepted(s,id,messages){
 const body={model:'fixture',messages,tools,chat_template_kwargs:{enable_thinking:true,reasoning_effort:'medium'},max_tokens:128};
 s.store.append('model_request',{requestId:id,body,prompt_tokens:33});s.store.append('model_accepted',{requestId:id});return body;
}
async function server(t){
 const state={free:1000,requests:[],erase:[],hold:false,started:null,toolResults:[]};
 state.started=new Promise(resolve=>state.resolveStarted=resolve);
 const app=http.createServer(async(req,res)=>{
  if(req.url==='/kv-cache')return res.end(JSON.stringify({ctf_btw:{enabled:true,kv_unified:true,main_slot:0,branch_slot:1,required_free_cells:100},slots:[{id:0,retained_tokens:state.mainTokens??100,state:state.mainState??'generating'}],contexts:{target:{supported:true,pools:[{kind:'attention',free_cells:state.free}]},draft:{supported:true,pools:[{kind:'attention',free_cells:state.free}]}}}));
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};state.requests.push({url:req.url,body});
  if(req.url==='/slots/1?action=erase'){state.erase.push(1);return res.end(JSON.stringify({id_slot:1,n_erased:10}));}
  if(req.url.endsWith('/input_tokens'))return res.end(JSON.stringify({input_tokens:50}));
  if(req.url==='/v1/chat/completions'){
   if(state.required&&state.free<=state.required){res.statusCode=503;return res.end(JSON.stringify({error:{message:`CTF_BTW_WAIT: required=${state.required}, available=${state.free}`}}));}
   res.setHeader('Content-Type','text/event-stream');res.flushHeaders();res.write(frame({role:'assistant',content:null,reasoning_content:null}));res.write(frame({reasoning_content:'分支思考',content:'分支回复'}));state.resolveStarted();
   if(state.badDelta)return res.end(frame({content:42})+'data: [DONE]\n\n');
   if(state.preemptNext){state.preemptNext=false;state.free=0;return res.end('data: '+JSON.stringify({error:{message:'CTF_BTW_WAIT: KV headroom reserved for main slot'}})+'\n\n');}
   const toolMessages=body.messages.filter(message=>message.role==='tool');
   if(state.toolCall&&!toolMessages.length)return res.end(frame({tool_calls:[{index:0,id:state.nativeToolId??'call_same',function:{name:state.toolName??'run_command',arguments:JSON.stringify(state.toolArgs??{command:'printf branch'})}}]},'tool_calls',{prompt_tokens:50,completion_tokens:4})+'data: [DONE]\n\n');
   if(state.truncateTool)return res.end(frame({tool_calls:[{index:0,id:state.nativeToolId??'call_same',function:{name:'run_command',arguments:JSON.stringify(state.toolArgs??{command:'printf branch'})}}]},'length',{prompt_tokens:50,completion_tokens:4})+'data: [DONE]\n\n');
   if(toolMessages.length)state.toolResults.push(toolMessages);
   if(state.hold)return;
   res.end(frame({},'stop',{prompt_tokens:50,completion_tokens:4})+'data: [DONE]\n\n');return;
  }
  res.statusCode=404;res.end('{}');
 });
 app.listen(0,'127.0.0.1');await once(app,'listening');
 t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
 return {state,url:'http://127.0.0.1:'+app.address().port};
}

test('knowledge calls stay in the branch and toggles take effect after the advertised turn',async t=>{
 const {state,url}=await server(t),s=session(t,url);let enabled=true;s.knowledgeControls=()=>({enabled});
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const mainTool=buildTools(s.store,{}, {},{}).find(t=>t.name==='knowledge');
 const mainResult=await mainTool.execute('call_same',{op:'search',query:'PHP fibers 怎么使用'});
 assert.equal(JSON.parse(mainResult.content[0].text).total,0);
 const digest=s.store.events.at(-1).digest,branch=BtwSession.create(s);
 state.toolCall=true;state.toolName='knowledge';state.toolArgs={op:'search',query:'CRC32'};
 const stream=branch.stream.bind(branch);branch.stream=async(...args)=>{const result=await stream(...args);if(result.calls.length)enabled=false;return result;};
 await branch.ask('Look up CRC32');
 assert.equal(s.store.events.at(-1).digest,digest);
 const result=branch.messages().find(m=>m.toolName==='knowledge');assert.ok(result);
 assert.equal(JSON.parse(result.content[0].text).results[0].id,'formats/png/crc-coverage');
 const requests=state.requests.filter(r=>r.url==='/v1/chat/completions');
 assert.ok(requests[0].body.tools.some(t=>t.function.name==='knowledge'));
 assert.ok(!requests[1].body.tools.some(t=>t.function.name==='knowledge'));
 assert.equal(branch.toolStore.events.filter(e=>e.type==='tool_start'&&e.data.name==='knowledge').length,1);
 assert.equal(s.store.events.filter(e=>e.type==='tool_start'&&e.data.name==='knowledge').length,1);
 enabled=true;assert.ok(branch.requestBody().tools.some(t=>t.function.name==='knowledge'));
 await branch.destroy();
});

test('knowledge receipts recover under their saved branch contract before a later disable takes effect',async t=>{
 const s=session(t);let enabled=true;s.knowledgeControls=()=>({enabled});
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s),call={id:'retained-knowledge',modelId:'call_same',name:'knowledge',arguments:{op:'get',id:'formats/png/crc-coverage'},requestId:1};
 branch.data.history.push({role:'assistant',content:'',toolCalls:[call],time:Date.now()});branch.save();
 await branch.tools().find(t=>t.name==='knowledge').execute(call.id,call.arguments);
 enabled=false;const reopened=new BtwSession(s);await reopened.executePendingTools();
 assert.equal(reopened.messages().filter(m=>m.toolName==='knowledge').length,1);
 assert.equal(reopened.toolStore.events.filter(e=>e.type==='tool_start'&&e.data.callId===call.id).length,1);
 assert.ok(!reopened.requestBody().tools.some(t=>t.function.name==='knowledge'));
 assert.equal(s.store.events.some(e=>e.type==='tool_start'),false);
});

test('snapshot uses the exact accepted compact view and excludes the incomplete response',t=>{
 const s=session(t);const original=[{role:'system',content:system},{role:'user',content:'original task'},{role:'user',content:'Recovery view; Compact summary contains EVIDENCE-42'},{role:'assistant',content:'completed round'},{role:'user',content:'newly observed tool result'}];
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'old'}]);
 s.store.append('model_response',{requestId:1,message:{role:'assistant',content:[{type:'text',text:'old answer'}],stopReason:'stop'}});
 accepted(s,2,original);
 const snap=snapshotBtw(s);assert.deepEqual(snap.body.messages,original);assert.deepEqual(snap.body.tools,tools);
 s.store.append('model_response',{requestId:2,message:{role:'assistant',content:[{type:'thinking',thinking:'reason'},{type:'text',text:'finished'}],stopReason:'stop'}});
 assert.deepEqual(snapshotBtw(s).body.messages.at(-1),{role:'assistant',content:'finished',reasoning_content:'reason'});
 assert.equal(s.store.events.filter(e=>e.type==='message').length,0);
});

test('preemption retains the partial answer and resumes only when target and draft have room',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s);state.preemptNext=true;const work=branch.ask('Find omissions');await state.started;await delay(100);
 assert.equal(branch.status,'waiting');assert.equal(branch.data.history.filter(x=>x.interrupted).length,1);
 state.free=1000;await work;assert.equal(branch.status,'idle');
 const calls=state.requests.filter(x=>x.url==='/v1/chat/completions');assert.equal(calls.length,2);assert.match(JSON.stringify(calls[1].body.messages),/因 KV 余量不足而暂停/);
 await branch.destroy();
});

test('backend admission requirement prevents repeated prefills while there is not enough room',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s);state.required=800;state.free=500;const work=branch.ask('Wait for room');
 await delay(1200);assert.equal(branch.status,'waiting');assert.equal(state.requests.filter(x=>x.url==='/v1/chat/completions').length,1);
 state.free=900;await work;assert.equal(state.requests.filter(x=>x.url==='/v1/chat/completions').length,2);await branch.destroy();
});

test('a main Compact invalidates a stale branch admission estimate',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s);state.required=800;state.free=500;state.mainTokens=3000;const work=branch.ask('Wait for room');
 await delay(150);assert.equal(state.requests.filter(x=>x.url==='/v1/chat/completions').length,1);
 state.mainTokens=100;state.required=400;await work;assert.equal(state.requests.filter(x=>x.url==='/v1/chat/completions').length,2);await branch.destroy();
});

test('branch tool calls persist a branch route and return only to the same branch',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const digest=s.store.events.at(-1).digest,id='a'.repeat(32),calls=[];let routeStore;
 const tool=branchTool(s.store.root,id,calls,{store:()=>routeStore}),branch=BtwSession.create(s,{branchId:id,tools:[tool]});routeStore=branch.toolStore;state.toolCall=true;
 await branch.ask('Inspect this');
 assert.equal(calls.length,1);assert.match(calls[0].callId,new RegExp('^btw-'+id+'-r1-c0$'));
 const assistant=branch.data.history.find(message=>message.role==='assistant'&&message.toolCalls?.length),toolResult=branch.data.history.find(message=>message.role==='tool');
 assert.equal(assistant.toolCalls[0].modelId,'call_same');assert.equal(toolResult.toolCallId,calls[0].callId);assert.equal(toolResult.modelToolCallId,'call_same');
 assert.equal(state.toolResults.length,1);assert.equal(state.toolResults[0][0].tool_call_id,'call_same');assert.match(state.toolResults[0][0].content,/btw-a{32}-r1-c0/);
 const first=state.requests.find(request=>request.url==='/v1/chat/completions').body;
 assert.equal(first.tool_choice,'auto');assert.equal(first.tools.some(tool=>tool.function.name==='submit_flag'),false);assert.match(first.messages.find(message=>typeof message.content==='string'&&message.content.includes('Harness routing notice')).content,new RegExp(id));
 assert.equal(branch.toolStore.events.some(event=>event.type==='btw_tool_dispatch'&&event.data.branch_id===id),true);
 assert.equal(s.store.events.at(-1).digest,digest);assert.equal(s.store.events.some(event=>event.type==='tool_start'),false);
 await branch.destroy();
});

test('a newly committed Compact snapshot retains its summary and later complete messages',t=>{
 const s=session(t);const ordinary=[{role:'user',content:'task',timestamp:1},{role:'assistant',content:[{type:'text',text:'old detail'}],stopReason:'stop',timestamp:2},{role:'user',content:'recent detail',timestamp:3}];
 for(const m of ordinary)s.store.append('message',m);
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'task'}]);
 s.store.append('compact_commit',{checkpoint:{cut:2,prefixHash:hash(JSON.stringify(ordinary.slice(0,2))),summary:{evidence:'verified item'},time:4}});
 const snap=snapshotBtw(s);assert.match(JSON.stringify(snap.body.messages),/verified item/);assert.match(JSON.stringify(snap.body.messages),/recent detail/);
 assert.doesNotMatch(JSON.stringify(snap.body.messages),/old detail/);
});

test('branch waits for real target and MTP headroom, preserves history on KV release, and advertises only branch tools',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main evidence'}]);
 const before=s.store.events.at(-1).digest,branch=BtwSession.create(s);state.free=50;
 const first=branch.ask('What is missing?');await delay(100);assert.equal(branch.status,'waiting');assert.equal(state.requests.length,0);
 state.free=1000;await first;
 const generation=state.requests.find(r=>r.url==='/v1/chat/completions').body;
 assert.equal(generation.id_slot,1);assert.equal(generation.tool_choice,'auto');assert.deepEqual(generation.messages.slice(0,branch.data.snapshot.body.messages.length),branch.data.snapshot.body.messages);assert.match(generation.messages.find(message=>typeof message.content==='string'&&message.content.includes('Harness routing notice')).content,/independent \/btw branch/);
 assert.equal(generation.tools.some(tool=>tool.function.name==='submit_flag'),false);
 assert.equal(branch.messages().length,2);assert.equal(s.store.events.at(-1).digest,before);
 await branch.free();assert.deepEqual(state.erase,[1]);assert.equal(branch.messages().length,2);
 await branch.ask('And another angle?');const last=state.requests.filter(r=>r.url==='/v1/chat/completions').at(-1).body;
 assert.match(JSON.stringify(last.messages),/What is missing/);assert.match(JSON.stringify(last.messages),/分支回复/);assert.equal(s.store.events.at(-1).digest,before);
 await branch.destroy();assert.equal(fs.existsSync(branch.file),false);
});

test('branch KV can always be released when main has exhausted its headroom',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s);branch.data.kvMayExist=true;state.free=0;
 await branch.free();
 assert.deepEqual(state.erase,[1]);assert.equal(branch.data.kvMayExist,false);assert.equal(branch.status,'idle');
 await branch.destroy();
});

test('branch cancellation saves partial output and never interrupts or erases the main slot',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const before=s.store.events.at(-1).digest,branch=BtwSession.create(s);state.hold=true;let mainGenerating=true;
 const result=branch.ask('Separate question');await state.started;await delay(30);assert.equal(branch.pause(),true);await result;
 assert.equal(branch.status,'paused');assert.equal(mainGenerating,true);assert.match(JSON.stringify(branch.messages()),/分支回复/);
 await branch.free();assert.deepEqual(state.erase,[1]);assert.equal(s.store.events.at(-1).digest,before);mainGenerating=false;
});

test('main and BTW tool calls with the same native ID stay in their own journals',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const id='b'.repeat(32),calls=[];let release,mainStarted,branchStarted;
 const gate=new Promise(resolve=>release=resolve),mainReady=new Promise(resolve=>mainStarted=resolve),branchReady=new Promise(resolve=>branchStarted=resolve);
 const main=s.store.execute('request-1:call_same','run_command',{command:'main'},async()=>{mainStarted();await gate;return {content:[{type:'text',text:'main-only'}]};});
 let routeStore;
 const tool=branchTool(s.store.root,id,calls,{store:()=>routeStore,wait:async()=>{branchStarted();await gate;}});
 const branch=BtwSession.create(s,{branchId:id,tools:[tool]});routeStore=branch.toolStore;
 state.toolCall=true;const work=branch.ask('Run the branch command');
 await Promise.all([mainReady,branchReady]);release();await Promise.all([main,work]);
 const mainCalls=s.store.events.filter(event=>event.type==='tool_start').map(event=>event.data.callId);
 const branchCalls=branch.toolStore.events.filter(event=>event.type==='tool_start').map(event=>event.data.callId);
 assert.deepEqual(mainCalls,['request-1:call_same']);assert.deepEqual(branchCalls,['btw-'+id+'-r1-c0']);
 assert.equal(state.toolResults.at(-1)[0].tool_call_id,'call_same');assert.doesNotMatch(state.toolResults.at(-1)[0].content,/main-only/);
 assert.equal(s.store.events.some(event=>event.type==='tool_start'&&event.data.callId.startsWith('btw-')),false);
 assert.equal(branch.toolStore.events.some(event=>event.type==='tool_start'&&event.data.callId==='request-1:call_same'),false);
 await branch.destroy();
});

test('reopened branch uses its own completed tool receipt instead of replaying side effects',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const id='c'.repeat(32),calls=[];let retainedStore,reopenedStore;
 const tool=branchTool(s.store.root,id,calls,{store:()=>retainedStore}),branch=BtwSession.create(s,{branchId:id,tools:[tool]});retainedStore=branch.toolStore;
 const call={id:'btw-'+id+'-r7-c0',modelId:'call_same',name:'run_command',arguments:{command:'printf retained'},requestId:7};
 branch.data.history.push({role:'assistant',content:'',toolCalls:[call],time:Date.now()});branch.save();
 await tool.execute(call.id,call.arguments);assert.equal(calls.length,1);
 const reopenedTool=branchTool(s.store.root,id,calls,{store:()=>reopenedStore}),reopened=new BtwSession(s,{tools:[reopenedTool]});reopenedStore=reopened.toolStore;
 await reopened.ask('Continue after retained receipt');
 assert.equal(calls.length,1);assert.equal(reopened.data.history.filter(message=>message.role==='tool'&&message.toolCallId===call.id).length,1);
 assert.equal(reopened.toolStore.events.filter(event=>event.type==='tool_start'&&event.data.callId===call.id).length,1);
 assert.equal(s.store.events.some(event=>event.type==='tool_start'),false);
 await reopened.destroy();
});

test('cancelling a branch tool records an unknown branch-only outcome and does not replay it',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const id='d'.repeat(32);let started,routeStore;
 const startedTool=new Promise(resolve=>started=resolve);
 const tool={name:'run_command',description:'Run a local branch command.',parameters:branchToolSchema,execute:async(callId,args,signal)=>{
  return routeStore.execute(callId,'run_command',args,async()=>{
   started();
   await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')), {once:true}));
   return {content:[{type:'text',text:'unexpected'}]};
  });
 }};
 const before=s.store.events.at(-1).digest,branch=BtwSession.create(s,{branchId:id,tools:[tool]});routeStore=branch.toolStore;state.toolCall=true;
 const work=branch.ask('Run and cancel');await startedTool;assert.equal(branch.pause(),true);await work;
 const result=branch.data.history.find(message=>message.role==='tool');
 assert.equal(branch.status,'paused');assert.equal(result.isError,true);assert.equal(result.details.execution_status,'unknown_after_interruption');
 assert.equal(branch.toolStore.events.filter(event=>event.type==='tool_done'&&event.data.callId===result.toolCallId).length,1);
 assert.equal(s.store.events.at(-1).digest,before);await branch.free();
});

test('branch input is durable before pending tool recovery runs',async t=>{
 const s=session(t);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const id='f'.repeat(32);let started,routeStore;
 const began=new Promise(resolve=>started=resolve);
 const tool={name:'run_command',description:'Run a local branch command.',parameters:branchToolSchema,execute:async(callId,args,signal)=>{
  return routeStore.execute(callId,'run_command',args,async()=>{
   started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')), {once:true}));
   return {content:[{type:'text',text:'unexpected'}]};
  });
 }};
 const branch=BtwSession.create(s,{branchId:id,tools:[tool]});routeStore=branch.toolStore;
 branch.data.history.push({role:'assistant',content:'',toolCalls:[{id:'btw-'+id+'-r1-c0',modelId:'call_same',name:'run_command',arguments:{command:'printf retained'},requestId:1}],time:Date.now()});branch.save();
 const work=branch.ask('Durably queued question');await began;
 assert.equal(JSON.parse(fs.readFileSync(branch.file,'utf8')).queuedInputs[0].text,'Durably queued question');
 branch.pause();await work;assert.equal(branch.data.queuedInputs[0].text,'Durably queued question');
});

test('a truncated branch tool draft never executes',async t=>{
 const {state,url}=await server(t),s=session(t,url);accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const id='e'.repeat(32),calls=[],before=s.store.events.at(-1).digest;let routeStore;
 const tool=branchTool(s.store.root,id,calls,{store:()=>routeStore}),branch=BtwSession.create(s,{branchId:id,tools:[tool]});routeStore=branch.toolStore;
 state.truncateTool=true;await branch.ask('Try a truncated tool');
 assert.equal(calls.length,0);assert.equal(branch.data.history.some(message=>message.toolCalls?.length),false);
 assert.equal(branch.toolStore.events.some(event=>event.type==='btw_tool_drafts_discarded'),true);
 assert.equal(s.store.events.at(-1).digest,before);await branch.destroy();
});

test('main preflight accepts only its own protected concurrent branch',async t=>{
 const s=session(t);const calls=[];
 const fetchFn=async url=>{calls.push(url);if(url.endsWith('/health'))return Response.json({status:'ok'});
  if(url.endsWith('/slots'))return Response.json([{id:0,is_processing:false,n_ctx:8192},{id:1,is_processing:true,n_ctx:8192}]);
  if(url.endsWith('/kv-cache'))return Response.json({ctf_btw:{enabled:true,kv_unified:true,main_slot:0,branch_slot:1}});
  return Response.json({default_generation_settings:{n_ctx:8192}});
 };
 const cfg={...s.config,nativeSlot:0,engineContextTokens:8192};
 await new NativeClient(cfg,s.store,{guard:()=>{},fetchFn,allowParallel:()=>true}).preflight();assert.ok(calls.some(x=>x.endsWith('/kv-cache')));
 await assert.rejects(new NativeClient(cfg,s.store,{guard:()=>{},fetchFn}).preflight(),/already processing/);
 const branchFetch=async url=>{if(url.endsWith('/health'))return Response.json({status:'ok'});
  if(url.endsWith('/slots'))return Response.json([{id:0,is_processing:true,n_ctx:8192},{id:1,is_processing:false,n_ctx:8192}]);
  if(url.endsWith('/kv-cache'))return Response.json({ctf_btw:{enabled:true,kv_unified:true,main_slot:0,branch_slot:1}});
  return Response.json({default_generation_settings:{n_ctx:8192}});
 };
 await new NativeClient({...cfg,nativeSlot:1},new Store(path.join(s.store.root,'branch-preflight')),{guard:()=>{},fetchFn:branchFetch,allowParallel:()=>true}).preflight();
});

test('managed backend enables two unified slots with a reserved main pool and does not restart an active branch',async t=>{
 const s=session(t),root=s.store.root,exe=path.join(root,'llama-server'),modelPath=path.join(root,'model.gguf'),runDir=path.join(root,'runtime');
 fs.writeFileSync(exe,'runtime');fs.writeFileSync(modelPath,'model');let launches=0,busy=false;
 const fetchFn=async url=>url.endsWith('/health')?Response.json({status:'ok'}):url.endsWith('/v1/models')?Response.json({data:[{id:'fixture'}]}):
  url.endsWith('/props')?Response.json({default_generation_settings:{n_ctx:8192}}):url.endsWith('/slots')?Response.json([{id:0,is_processing:false},{id:1,is_processing:busy}]):
  Response.json({ctf_btw:{enabled:true,kv_unified:true,main_slot:0,branch_slot:1}});
 const executeFn=async(_cmd,args)=>{launches++;const launch=JSON.parse(fs.readFileSync(args[1],'utf8'));fs.writeFileSync(path.join(runDir,'owner.json'),JSON.stringify({...launch,selectionId:launch.requestId}));};
 const catalog=new ModelCatalog({contestDir:root,modelRuntime:{exe,runDir,platform:'linux',btw:{enabled:true,reserveCells:512}}},{fetchFn,executeFn,guard:()=>{}});
 const profile={id:'fixture',model:'fixture',baseUrl:s.config.baseUrl,modelPath,contextTokens:8192,mtpTokens:2};
 const current={...s.config,promptTokens:4096,compactSoftTokens:3000};
 await catalog.activate(profile,current);const launch=JSON.parse(fs.readFileSync(path.join(runDir,'selection.json'),'utf8'));
 const at=flag=>launch.args[launch.args.indexOf(flag)+1];
 assert.equal(at('-np'),'2');assert.equal(at('-c'),'8192');assert.equal(at('--ctf-btw-reserve'),'512');
 assert.ok(launch.args.includes('--kv-unified'));assert.ok(launch.args.includes('--no-cache-idle-slots'));assert.equal(at('--fit'),'off');assert.equal(at('--spec-type'),'draft-mtp');
 busy=true;await catalog.activate(profile,current,{allowBtw:true});assert.equal(launches,1);
});

// llama-server starts every chat stream with role=assistant, content=null.
test('nullable role and reasoning deltas do not abort branch generation',async t=>{
 const {url}=await server(t),s=session(t,url);
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const mainDigest=s.store.events.at(-1).digest,branch=BtwSession.create(s);
 await branch.ask('Continue alongside main');
 assert.equal(branch.status,'idle');
 assert.equal(branch.data.history.at(-1).content,'分支回复');
 assert.equal(branch.data.history.at(-1).reasoning,'分支思考');
 assert.equal(s.store.events.at(-1).digest,mainDigest);
 assert.equal(branch.toolStore.events.filter(e=>e.type==='btw_model_response').length,1);
});

test('malformed non-null deltas preserve partial output and record a branch-only failure',async t=>{
 const {state,url}=await server(t),s=session(t,url);state.badDelta=true;
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const mainDigest=s.store.events.at(-1).digest,branch=BtwSession.create(s);
 await assert.rejects(branch.ask('Inspect'),/Invalid branch content delta/);
 assert.equal(branch.data.history.at(-1).content,'分支回复');
 const failed=branch.toolStore.events.find(e=>e.type==='btw_generation_failed');
 assert.equal(failed.data.error,'Invalid branch content delta');
 assert.equal(failed.data.branch_id,branch.data.branchId);
 assert.equal(failed.data.request_id,1);
 assert.equal(s.store.events.at(-1).digest,mainDigest);
 assert.equal(new BtwSession(s).toolStore.events.at(-1).type,'btw_generation_failed');
});

test('an awaited branch turn releases its running state before immediate follow-up',async t=>{
 const {url}=await server(t),s=session(t,url);
 accepted(s,1,[{role:'system',content:system},{role:'user',content:'main'}]);
 const branch=BtwSession.create(s);
 await branch.ask('First question');
 assert.equal(branch.running,null);assert.equal(branch.controller,null);
 await branch.ask('Immediate follow-up');
 assert.equal(branch.data.history.filter(m=>m.role==='assistant').length,2);
});
