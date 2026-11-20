import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createInitialSystemMessage} from '@earendil-works/pi-ai';
import {ContextManager,groups,wire} from './context.mjs';
import {atomic} from './store.mjs';
import {streamChunks} from './native-stream.mjs';

const copy=value=>structuredClone(value);
const assistantWire=m=>({role:'assistant',content:(m.content??[]).filter(x=>x.type==='text').map(x=>x.text).join(''),
 reasoning_content:(m.content??[]).filter(x=>x.type==='thinking').map(x=>x.thinking).join('')});

// Start from the exact input accepted by the most recent ordinary request.
// An in-flight response and an incomplete tool group are never included.
export function snapshotBtw(session){
 const events=session.store.events;
 const request=events.findLast(e=>e.type==='model_request'&&!e.data.kind&&events.some(a=>a.type==='model_accepted'&&a.data.requestId===e.data.requestId));
 if(!request)throw Error('主线尚无完整的模型上下文，请等首次请求开始后再使用 /btw');
 const body=copy(request.data.body);
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages[0].role!=='system'||!Array.isArray(body.tools))throw Error('主线请求缺少可分叉的实际上下文');
 let messages=body.messages;
 const commit=events.findLast(e=>e.type==='compact_commit');
 if(commit&&commit.seq>request.seq){
  const tools=body.tools.map(t=>t.function);
  const system=createInitialSystemMessage(messages[0].content,tools);
  const ordinary=session.messages().filter(m=>m.role!=='system');
  // The compact checkpoint is made at a safe boundary. Do not include a tool
  // call until all of its results exist; no later messages are spliced in.
  while(ordinary.length){try{groups(ordinary);break;}catch{ordinary.pop();}}
  const cm=new ContextManager(session.store,{...session.config,...session.sessionWindow});
  messages=wire(cm.assemble(system,ordinary,cm.checkpoint())).messages;
 }else{
  const response=events.findLast(e=>e.type==='model_response'&&e.data.requestId===request.data.requestId)?.data.message;
  if(response?.stopReason==='stop'&&!response.content?.some(p=>p.type==='toolCall'))messages.push(assistantWire(response));
 }
 return {taskId:session.task.id,requestId:request.data.requestId,compactSeq:commit?.seq??null,
  model:session.config.model,baseUrl:session.config.baseUrl,contextTokens:(session.sessionWindow??session.config).contextTokens,
  generationTokens:session.config.generationTokens,body:{...body,messages,tools:copy(body.tools)}};
}

function btwPolicy(snapshot){
 const policy=snapshot?.ctf_btw;
 if(!policy?.enabled||!policy.kv_unified||policy.main_slot!==0||policy.branch_slot!==1||!Number.isSafeInteger(policy.required_free_cells))
  throw Error('当前后端不支持安全并发分支；请构建并启用带 /btw 补丁的 llama-server');
 return policy;
}

function headroom(snapshot,required=0){
 const policy=btwPolicy(snapshot);
 const contexts=Object.values(snapshot.contexts??{}).filter(Boolean);
 if(!contexts.length||contexts.some(c=>!c.supported))throw Error('后端 KV cell 统计不完整，不能安全申请分支 slot');
 const pools=contexts.flatMap(c=>c.pools??[]).filter(p=>['attention','attention_swa'].includes(p.kind));
 if(!pools.length||pools.some(p=>!Number.isSafeInteger(p.free_cells)))throw Error('后端未提供可用 KV cell 数量');
 return pools.every(p=>p.free_cells>Math.max(policy.required_free_cells,required));
}

export class BtwSession extends EventEmitter {
 constructor(session,{fetchFn=fetch,guard=()=>{},snapshot}={}){
  super();this.session=session;this.fetch=fetchFn;this.guard=guard;
  this.file=path.join(session.store.root,'btw-branch.json');
  this.data=snapshot??(fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):null);
  if(!this.data)throw Error('没有可恢复的分支');
  if(this.data.version!==1||this.data.snapshot?.taskId!==session.task.id||!Array.isArray(this.data.history)||!Array.isArray(this.data.snapshot.body?.messages))throw Error('分支记录无效或不属于当前题目');
  const origin=new URL(this.data.snapshot.baseUrl);
  if(origin.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname))throw Error('分支模型服务必须使用本机 HTTP 地址');
  this.status='idle';this.live=null;this.controller=null;this.running=null;this.error='';this.destroyed=false;this.releasing=false;
 }
 static create(session,options={}){
  const data={version:1,snapshot:snapshotBtw(session),history:[],createdAt:Date.now(),kvMayExist:false};
  const branch=new BtwSession(session,{...options,snapshot:data});branch.save();return branch;
 }
 save(){atomic(this.file,this.data);this.emit('change');}
 messages(){return this.data.history.map(m=>({role:m.role,content:[...(m.reasoning?[{type:'thinking',thinking:m.reasoning}]:[]),...(m.content?[{type:'text',text:m.content}]:[])],timestamp:m.time,harnessOperatorInterrupted:m.interrupted}));}
 activeOn(origin){return Boolean(this.running)&&this.data.snapshot.baseUrl===origin;}
 requestBody(){
  const s=this.data.snapshot,b=copy(s.body);
  for(const key of ['response_format','stream_options','id_slot','n_predict'])delete b[key];
  b.messages.push(...this.data.history.map(m=>({role:m.role,content:m.content,...(m.role==='assistant'&&m.reasoning?{reasoning_content:m.reasoning}:{})})));
  return {...b,model:s.model,id_slot:1,tool_choice:'none',parallel_tool_calls:false,cache_prompt:true,max_tokens:s.generationTokens};
 }
 async json(route,{method='GET',body,signal,timeout=10000}={}){
  this.guard();signal?.throwIfAborted();
  const response=await this.fetch(this.data.snapshot.baseUrl+route,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
   headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  if(!response.ok){const detail=await response.text();const error=Error(`后端 HTTP ${response.status}: ${detail.slice(0,1000)}`);error.wait=detail.includes('CTF_BTW_WAIT');throw error;}
  return response.json();
 }
 ask(text){
  if(this.running)throw Error('分支正在生成或等待 KV；可先按 Ctrl+C 暂停');
  if(this.releasing)throw Error('分支 KV 正在释放，请稍后再试');
  if(this.destroyed)throw Error('分支已删除');
  if(typeof text!=='string'||!text.trim())throw Error('请输入分支问题');
  if(this.session.config.model!==this.data.snapshot.model||this.session.config.baseUrl!==this.data.snapshot.baseUrl)throw Error('主线模型已改变，请切回原模型或删除分支');
  this.data.history.push({role:'user',content:text,time:Date.now()});this.save();
  this.controller=new AbortController();this.status='waiting';this.error='';
  const run=this.generate(this.controller.signal);this.running=run;
  run.catch(()=>{}).finally(()=>{if(this.running===run){this.running=null;this.controller=null;this.emit('change');}});
  this.emit('change');return run;
 }
 async generate(signal){
  let content='',reasoning='',required=0,requiredAt=null;
  try {
   for(;;){
    signal.throwIfAborted();
    const snapshot=await this.json('/kv-cache',{signal,timeout:4000});
    const main=snapshot.slots?.find(slot=>slot.id===0);
    // Compact or a substantial change in the main prefix can change how
    // much the backend can share. Re-evaluate an old admission estimate.
    if(required&&requiredAt&&Number.isSafeInteger(main?.retained_tokens)&&
       (main.retained_tokens<requiredAt.tokens||main.retained_tokens>=requiredAt.tokens+2048||
        (main.state==='idle'&&requiredAt.state!=='idle'))){required=0;requiredAt=null;}
    if(!headroom(snapshot,required)){this.status='waiting';this.emit('change');await delay(1000,undefined,{signal});continue;}
    const body=this.requestBody();
    const count=await this.json('/v1/chat/completions/input_tokens',{method:'POST',body,signal,timeout:30000});
    if(!Number.isSafeInteger(count.input_tokens)||count.input_tokens<1)throw Error('后端未返回准确的分支 token 数');
    if(count.input_tokens+body.max_tokens>this.data.snapshot.contextTokens)throw Error('分支历史和输出预留超过上下文容量；请在主线 Compact 后重新分叉');
    this.guard();this.data.kvMayExist=true;this.save();
    const response=await this.fetch(this.data.snapshot.baseUrl+'/v1/chat/completions',{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json'},
     body:JSON.stringify({...body,stream:true,stream_options:{include_usage:true}})});
    if(!response.ok){const detail=await response.text();if(detail.includes('CTF_BTW_WAIT')){required=Number(/required=(\d+)/.exec(detail)?.[1]??0);requiredAt=Number.isSafeInteger(main?.retained_tokens)?{tokens:main.retained_tokens,state:main.state}:null;this.status='waiting';this.emit('change');await delay(1000,undefined,{signal});continue;}throw Error(`分支请求失败 HTTP ${response.status}: ${detail.slice(0,1000)}`);}
    required=0;requiredAt=null;
    this.status='generating';this.emit('change');
    let buffer='',finish=null,done=false,usage=null;const decoder=new TextDecoder();
    const line=value=>{
     if(!value.startsWith('data:'))return;
     const payload=value.slice(5).trim();if(payload==='[DONE]'){done=true;return;}
     const chunk=JSON.parse(payload);if(chunk.error){const error=Error(JSON.stringify(chunk.error));error.wait=error.message.includes('CTF_BTW_WAIT');throw error;}
     const choice=chunk.choices?.[0];if(chunk.usage)usage=chunk.usage;if(!choice)return;
     if(choice.delta?.tool_calls?.length)throw Error('只读分支收到工具调用，已丢弃且未执行');
     content+=choice.delta?.content??'';reasoning+=choice.delta?.reasoning_content??'';finish=choice.finish_reason??finish;
     this.live={role:'assistant',content:[...(reasoning?[{type:'thinking',thinking:reasoning}]:[]),...(content?[{type:'text',text:content}]:[])]};this.emit('change');
    };
    try{
     for await(const bytes of streamChunks(response.body,signal)){
      buffer+=decoder.decode(bytes,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}
     }
     buffer+=decoder.decode();if(buffer.trim())line(buffer.trimEnd());signal.throwIfAborted();
    }catch(error){
     if(!error.wait||signal.aborted)throw error;
     if(content||reasoning){
      this.data.history.push({role:'assistant',content,reasoning,time:Date.now(),interrupted:true});
      this.data.history.push({role:'user',content:'请继续刚才因 KV 余量不足而暂停的回答。',time:Date.now()});
      this.save();content='';reasoning='';this.live=null;
     }
     this.status='waiting';this.emit('change');await delay(1000,undefined,{signal});continue;
    }
    if(!done||!['stop','length'].includes(finish)||!usage||usage.prompt_tokens!==count.input_tokens||!content)throw Error('分支响应不完整或 token 统计不匹配');
    this.data.history.push({role:'assistant',content,reasoning,time:Date.now(),truncated:finish==='length'});
    this.live=null;this.status='idle';this.save();return;
   }
  }catch(error){
   if(content||reasoning)this.data.history.push({role:'assistant',content,reasoning,time:Date.now(),interrupted:true});
   this.live=null;this.status=signal.aborted?'paused':error.wait?'waiting':'error';this.error=signal.aborted?'已暂停':error.message;
   this.save();if(!signal.aborted)throw error;
  }
 }
 pause(){if(!this.running)return false;this.controller?.abort();return true;}
 async free(){
  if(this.releasing)throw Error('分支 KV 正在释放');
  this.releasing=true;
  try{
   this.pause();await this.running?.catch(()=>{});
   if(this.data.kvMayExist===false){this.status='idle';this.error='';this.emit('change');return {id_slot:1,n_erased:0,skipped:true};}
   // Releasing slot 1 is the recovery path when main has consumed all
   // headroom.  Validate the protected backend, but do not require spare KV
   // cells before asking it to erase the branch.
   const snapshot=await this.json('/kv-cache',{timeout:4000});btwPolicy(snapshot);
   const result=await this.json('/slots/1?action=erase',{method:'POST',body:{},timeout:30000});
   if(result.id_slot!==1)throw Error('后端没有确认释放分支 slot');
   this.data.kvMayExist=false;this.status='idle';this.error='';this.save();return result;
  }finally{this.releasing=false;}
 }
 async destroy(){await this.free();this.destroyed=true;fs.rmSync(this.file,{force:true});this.emit('change');}
}
