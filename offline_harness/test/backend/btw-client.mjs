// Run only against an isolated, idle server named btw-test on a non-production port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {BtwSession} from '../../src/btw-session.mjs';
import {Store} from '../../src/store.mjs';
import {NativeClient} from '../../src/native.mjs';
const origin=new URL(process.argv[2]);
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');
assert.ok(origin.port&&origin.port!=='8080');
const base=origin.origin,controller=new AbortController();
const json=async route=>{
 for(let attempt=0;;attempt++)try{const r=await fetch(base+route,{signal:AbortSignal.timeout(5000)});assert.ok(r.ok);return await r.json();}
 catch(error){if(attempt||!['UND_ERR_SOCKET','ECONNRESET'].includes(error.cause?.code))throw error;}
};
assert.deepEqual((await json('/v1/models')).data.map(m=>m.id),['btw-test']);
const initial=await json('/kv-cache');assert.ok(initial.ctf_btw?.enabled);
assert.ok(initial.slots.every(s=>!s.is_processing&&!s.retains_kv));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'btw-live-client-'));
const store=new Store(root),config={model:'btw-test',baseUrl:base,contextTokens:(await json('/props')).default_generation_settings.n_ctx,generationTokens:128,nativeSlot:0};
const session={task:{id:'isolated-live'},config,store,messages:()=>[],knowledgeControls:()=>({enabled:false})};
const body={model:'btw-test',id_slot:0,messages:[{role:'system',content:'Follow the user instructions precisely. '+ 'Discuss facts and evidence. '.repeat(45)},{role:'user',content:'Write all integers from 1 to 1000 in order, without skipping any. Do not stop early.'}],tools:[],max_tokens:1024,temperature:0,cache_prompt:true,chat_template_kwargs:{enable_thinking:false},stream:true,stream_options:{include_usage:true}};
let branch,mainWork,monitor,mainDone=false,textChunks=0,bothGenerating=false,mainText='',mainFinish=false,raw='';
async function until(check){const deadline=Date.now()+120000;while(!check()){if(Date.now()>deadline)throw Error('Live concurrency check timed out');await delay(25);}}
try{
 store.append('model_request',{requestId:1,body});
 const response=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'},signal:controller.signal});assert.ok(response.ok);
 store.append('model_accepted',{requestId:1});const mainDigest=store.events.at(-1).digest;
 mainWork=(async()=>{let buffer='';const decoder=new TextDecoder();for await(const bytes of response.body){const chunk=decoder.decode(bytes,{stream:true});raw+=chunk;buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')continue;const e=JSON.parse(line.slice(5));assert.ok(!e.error,JSON.stringify(e.error));const choice=e.choices?.[0];if(choice?.delta?.content){mainText+=choice.delta.content;textChunks++;}if(choice?.finish_reason)mainFinish=true;}}mainDone=true;})();mainWork.catch(()=>{});
 await until(()=>textChunks>=5);
 let monitoring=true;
 monitor=(async()=>{while(monitoring&&!mainDone){const state=await json('/kv-cache');if(state.scheduler.generating===2)bothGenerating=true;await delay(50);}})();monitor.catch(()=>{});
 branch=BtwSession.create(session,{tools:[]});
 try{
  await branch.ask('In your own reply, write integers 1 through 40.');
  assert.equal(branch.status,'idle');assert.ok(branch.data.history.at(-1).content);assert.ok(!mainDone,'Main must still be generating when branch finishes');
  const before=textChunks;const pending=branch.ask('Now write integers 1 through 1000 without skipping any.');pending.catch(()=>{});
  await until(()=>Boolean(branch.live)&&textChunks>before);
  branch.pause();await pending;assert.equal(branch.status,'paused');
  await branch.free();const afterCancel=textChunks;await until(()=>textChunks>afterCancel||mainDone);assert.ok(textChunks>afterCancel,'Main must continue after branch cancellation');
  await mainWork;assert.ok(mainText.length>100&&mainFinish&&raw.includes('[DONE]'));
  assert.equal(store.events.at(-1).digest,mainDigest,'Branch may not write into the main journal');
  assert.ok(bothGenerating,'Both slots must actually generate concurrently');
  // Start another main round while the branch owns slot 1.
  const nextBranch=branch.ask('Write every integer from 2001 to 3000, one per line. Do not stop early.');nextBranch.catch(()=>{});
  await until(()=>Boolean(branch.live));
  const preflightStore=new Store(path.join(root,'preflight'));
  await new NativeClient(config,preflightStore,{guard:()=>{},allowParallel:()=>true}).preflight();
  const nextResponse=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,max_tokens:16,messages:[...body.messages,{role:'user',content:'Reply with OK only.'}]}),signal:controller.signal});
  assert.ok(nextResponse.ok);assert.ok((await nextResponse.text()).includes('[DONE]'));
  branch.pause();await nextBranch;
  const beforeFree=await json('/kv-cache');await branch.free();const afterFree=await json('/kv-cache');
  for(const name of ['target','draft']){
   if(!beforeFree.contexts[name])continue;
   const occupied=(state,seq)=>state.contexts[name].pools.filter(p=>p.kind.startsWith('attention')).reduce((n,p)=>n+(p.sequences.find(s=>s.id===seq)?.occupied_cells??0),0);
   assert.equal(occupied(afterFree,0),occupied(beforeFree,0));assert.equal(occupied(afterFree,1),0);
  }
  monitoring=false;await monitor;
  console.log(JSON.stringify({passed:true,bothGenerating,mainTextChars:mainText.length,branchResponses:branch.toolStore.events.filter(e=>e.type==='btw_model_response').length,cancelKeptMainRunning:true,branchReleasePreservedMain:true}));
 }finally{monitoring=false;await monitor;}
}finally{
 branch?.pause();await branch?.running?.catch(()=>{});controller.abort();await mainWork?.catch(()=>{});
 fs.rmSync(root,{recursive:true,force:true});
}
