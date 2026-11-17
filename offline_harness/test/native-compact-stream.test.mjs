import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {NativeClient} from '../src/native.mjs';
import {Store} from '../src/store.mjs';
import {validateCompact} from '../src/compact-prompts.mjs';
import {envelope} from './compact-fixture.mjs';
const cfg={model:'fixture',contextTokens:65536,generationTokens:4096,reasoningTokens:512};
const input={messages:[{role:'user',content:'Synthetic state recovery fixture'}],tools:[{type:'function',function:{name:'fixture',description:'Synthetic definition retained in the prefix',parameters:{type:'object',properties:{},additionalProperties:false}}}]};
function store(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'compact-stream-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new Store(root);}
const frame=(delta,finish=null,usage)=>'data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage})+'\n\n';
test('real HTTP auxiliary sends early headers and persists partial SSE before committing one complete response',async t=>{
 const s=store(t);let requests=0,started;
 const accepted=new Promise(r=>started=r),content=envelope(),first=content.slice(0,40),last=content.slice(40);
 const app=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
  if(req.url.endsWith('input_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":49026}');return;}
  requests++;assert.equal(body.stream,true);assert.equal(body.response_format.json_schema.strict,true);assert.deepEqual(body.tools,input.tools);
  assert.equal(body.tool_choice,'none');assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false,reasoning_effort:'medium'});
  res.setHeader('content-type','text/event-stream');res.flushHeaders();res.write(': Synthetic transport evidence\n\n');res.write(frame({content:first}));started();
  setTimeout(()=>{res.write(frame({content:last},'stop',{prompt_tokens:49026,completion_tokens:300}));res.end('data: [DONE]\n\n');},250);
 });app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
 const client=new NativeClient({...cfg,baseUrl:'http://127.0.0.1:'+app.address().port},s,{guard:()=>{}});
 let complete=false;const pending=client.complete(input,{kind:'compact',maxTokens:4096}).then(x=>{complete=true;return x;});
 await accepted;
 for(let n=0;n<100&&!fs.existsSync(path.join(s.root,'request-1.sse'));n++)await new Promise(r=>setTimeout(r,2));
 assert.ok(fs.existsSync(path.join(s.root,'request-1.sse')));assert.equal(complete,false);assert.equal(s.events.filter(e=>e.type==='model_auxiliary_response').length,0);
 const output=await pending;validateCompact(output);assert.equal(output,content);assert.equal(requests,1);
 assert.equal(s.events.filter(e=>e.type==='model_request').length,1);assert.equal(s.events.filter(e=>e.type==='model_auxiliary_response').length,1);
 assert.match(fs.readFileSync(path.join(s.root,'request-1.sse'),'utf8'),/Synthetic transport evidence/);
});
test('incomplete auxiliary streams retain evidence and cannot become successful checkpoint input',async t=>{
 for(const fault of ['missing_done','missing_usage','wrong_input','length','tools','negative_usage','reasoning']){
  const s=store(t),usage=fault==='missing_usage'?undefined:{prompt_tokens:fault==='wrong_input'?101:100,completion_tokens:fault==='negative_usage'?-1:30};
  const stream=frame({content:envelope(),...(fault==='tools'?{tool_calls:[{index:0}]}:{}),...(fault==='reasoning'?{reasoning_content:'Unexpected generated thought'}:{})},fault==='length'?'length':'stop',usage)+(fault==='missing_done'?'':'data: [DONE]\n\n');
  const client=new NativeClient({...cfg,baseUrl:'http://127.0.0.1:8081'},s,{guard:()=>{},fetchFn:async(url)=>url.endsWith('input_tokens')?Response.json({input_tokens:100}):new Response(stream)});
  await assert.rejects(client.complete(input,{kind:'compact',maxTokens:4096}),/Invalid or truncated compact/);
  assert.equal(s.events.filter(e=>e.type==='model_auxiliary_response'||e.type==='compact_commit').length,0);
  assert.equal(fs.readFileSync(path.join(s.root,'request-1.sse'),'utf8'),stream);
 }
});
test('task abort cancels a live auxiliary stream without accepting partial compact output',async t=>{
 const s=store(t),controller=new AbortController();let started;
 const accepted=new Promise(r=>started=r);
 const app=http.createServer(async(req,res)=>{
  for await(const c of req){};
  if(req.url.endsWith('input_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":100}');return;}
  res.setHeader('content-type','text/event-stream');res.flushHeaders();res.write(frame({content:'{"partial":'}));started();
 });app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.closeAllConnections();app.close();});
 const client=new NativeClient({...cfg,baseUrl:'http://127.0.0.1:'+app.address().port},s,{guard:()=>{}});
 const result=client.complete(input,{kind:'compact',maxTokens:4096,signal:controller.signal});
 await accepted;controller.abort();await assert.rejects(result,/abort/i);
 assert.equal(s.events.filter(e=>e.type==='model_auxiliary_response'||e.type==='compact_commit').length,0);
});
