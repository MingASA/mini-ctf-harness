import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runTask} from '../src/runner.mjs';
import {Store} from '../src/store.mjs';
import {ContextManager} from '../src/context.mjs';
import {hardLimitContinuation} from '../src/truncation.mjs';
import {envelope,controlPayload} from './compact-fixture.mjs';
const cfg=root=>({runDir:root,mode:'memory',baseUrl:'http://127.0.0.1:8081',model:'fixture',contextTokens:12000,promptTokens:5000,compactSoftTokens:5000,compactHardTokens:6000,compactTokens:1024,compactTailGroups:1,generationTokens:2048,reasoningTokens:512,safetyTokens:64,maxSeconds:60,maxTurns:20});
const sse=(delta,finish,input,output)=>new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}})+'\n\ndata: [DONE]\n\n');
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'truncated-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const metadata=url=>Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:12000}});
test('actual Pi measured-capacity truncation queues one observation, compacts once and executes the next complete tool',async t=>{
 const root=temp(t);let normal=0,compacts=0;
 const count=b=>JSON.stringify(b.messages).includes('Recovery view;')||b.messages.length<=3||JSON.stringify(b.messages).includes('Unfinished synthetic reasoning')?1000:b.response_format?8656:4000;
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return metadata(url);const b=JSON.parse(opt.body),input=count(b);
  if(url.endsWith('input_tokens'))return Response.json({input_tokens:input});
  if(b.response_format){compacts++;const humans=controlPayload(b).retained_human_instructions;assert.ok(!humans.some(x=>JSON.stringify(x).includes('Harness observation:')));return sse({content:envelope()},'stop',input,200);}
  normal++;
  if(normal===1)return sse({tool_calls:[{index:0,id:'read',function:{name:'read',arguments:JSON.stringify({path:'/work/input.txt'})}}]},'tool_calls',input,20);
  if(normal===2){assert.equal(b.max_tokens,2000);return sse({reasoning_content:'Unfinished synthetic reasoning',tool_calls:[{index:0,id:'partial',function:{name:'run_command',arguments:'{"command":'}}]},'length',input,2000);}
  // This is the actual incident trigger: an assistant tail yields only EOS.
  if(b.messages.at(-1).role==='assistant')return sse({},'stop',input,1);
  if(normal===3)return sse({tool_calls:[{index:0,id:'read-again',function:{name:'read',arguments:JSON.stringify({path:'/work/input.txt'})}}]},'tool_calls',input,20);
  return sse({content:'Synthetic fixture complete'},'stop',input,20);
 };
 const result=await runTask({id:'truncated-live',objective:'Continue a synthetic measurement after a context boundary.'},cfg(root),{guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{},readFile:async()=>Buffer.from('Synthetic measurement retained')}});
 assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));assert.equal(normal,4);assert.equal(compacts,1);
 const s=new Store(root);assert.equal(s.events.filter(e=>e.type==='message'&&e.data.harnessTruncationContinuationFor!==undefined).length,1);
 assert.equal(s.events.filter(e=>e.type==='compact_commit').length,1);assert.equal(s.events.filter(e=>e.type==='tool_start').length,2);assert.ok(!s.events.some(e=>e.type==='tool_start'&&e.data.name==='run_command'));assert.equal(s.pending().length,0);
});
test('legacy truncated assistant tail resumes from its committed compact without repeating compact or tools',async t=>{
 const root=temp(t),config=cfg(root),task={id:'truncated-resume',objective:'Preserve a synthetic measurement.'};let requests=0;
 const options={guard:()=>{},testMode:true,knowledge:{docs:[]},broker:{validate:async()=>{},readFile:async()=>Buffer.from('Synthetic measurement retained')},fetchFn:async(url,opt)=>{
  if(!opt?.body)return metadata(url);const b=JSON.parse(opt.body);
  if(url.endsWith('input_tokens'))return Response.json({input_tokens:1000});
  if(b.response_format)throw Error('Committed Compact must not be regenerated');
  requests++;if(requests===1)return new Response('',{status:500});
  assert.equal(b.messages.at(-1).role,'user');return sse({content:'Synthetic restart complete'},'stop',1000,20);
 }};
 assert.equal((await runTask(task,config,options)).status,'needs_review');
 const s=new Store(root);s.append('message',{role:'assistant',content:[{type:'text',text:'Earlier synthetic exploration'}],stopReason:'stop',timestamp:1});
 const marker={role:'assistant',content:[{type:'thinking',thinking:'Unfinished thought'},{type:'text',text:'[Generation truncated at the hard context boundary.]'}],stopReason:'stop',harnessTruncated:true,timestamp:2};
 s.append('model_truncated',{reason:'hard_context_limit',requestId:1});s.append('message',marker);
 const messages=[{role:'system',content:'Rules'},...s.events.filter(e=>e.type==='message'&&e.data.stopReason!=='error').map(e=>e.data)];
 await new ContextManager(s,config).build(messages,async()=>1000,async()=>envelope());
 assert.equal(s.events.filter(e=>e.type==='compact_commit').length,1);const prefix=fs.readFileSync(s.file);
 const result=await runTask(task,config,{...options,resume:true});assert.equal(result.status,'model_stopped_without_verified_answer',JSON.stringify(result));
 const after=new Store(root);assert.equal(after.events.filter(e=>e.type==='compact_commit').length,1);assert.equal(after.events.filter(e=>e.type==='tool_start').length,0);assert.deepEqual(fs.readFileSync(s.file).subarray(0,prefix.length),prefix);assert.equal(after.events.filter(e=>e.type==='message'&&e.data.harnessTruncationContinuationFor!==undefined).length,1);
});
test('ordinary assistant tails and unproven truncation are still rejected',t=>{
 const s=new Store(temp(t)),message={role:'assistant',stopReason:'stop',harnessTruncated:true,content:[{type:'text',text:'Unproven marker'}]};s.append('message',message);
 assert.throws(()=>hardLimitContinuation(s,message),/Missing native/);assert.throws(()=>hardLimitContinuation(s,{...message,harnessTruncated:false}),/explicit review/);
});
