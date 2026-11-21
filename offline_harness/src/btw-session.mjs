import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createInitialSystemMessage} from '@earendil-works/pi-ai';
import {ContextManager,groups,wire} from './context.mjs';
import {Store,atomic,hash} from './store.mjs';
import {DockerBroker} from './broker.mjs';
import {buildTools} from './tools.mjs';
import {toolError} from './tool-errors.mjs';
import {streamChunks} from './native-stream.mjs';

const copy=value=>structuredClone(value);
const BRANCH_ID=/^[a-f0-9]{16,64}$/;
const assistantWire=m=>({role:'assistant',content:(m.content??[]).filter(x=>x.type==='text').map(x=>x.text).join(''),
 reasoning_content:(m.content??[]).filter(x=>x.type==='thinking').map(x=>x.thinking).join('')});
const newBranchId=()=>crypto.randomUUID().replaceAll('-','');
const validBranchId=id=>typeof id==='string'&&BRANCH_ID.test(id);
const fallbackBranchId=(session,data)=>hash(session.store.root+'\0'+data.createdAt+'\0'+data.snapshot?.requestId).slice(0,32);

function toolBlocks(value){
 if(typeof value==='string')return [{type:'text',text:value}];
 if(!Array.isArray(value))throw Error('Invalid branch tool result content');
 return value.map(block=>{
  if(block?.type==='text'&&typeof block.text==='string')return {type:'text',text:block.text};
  if(block?.type==='image'&&['image/png','image/jpeg'].includes(block.mimeType)&&typeof block.data==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(block.data))return {type:'image',mimeType:block.mimeType,data:block.data};
  throw Error('Unsupported branch tool result content');
 });
}
function rawHistory(history){
 const result=[],images=[];
 const flush=()=>{if(images.length)result.push({role:'user',content:[{type:'text',text:'Task images returned by the preceding tool calls.'},...images.splice(0)]});};
 for(const message of history){
  if(message.role!=='tool')flush();
  if(message.role==='user'){
   if(typeof message.content!=='string')throw Error('Invalid branch user history');
   result.push({role:'user',content:message.content});
  }else if(message.role==='assistant'){
   const assistant={role:'assistant',content:typeof message.content==='string'?message.content:''};
   if(message.reasoning)assistant.reasoning_content=message.reasoning;
   if(Array.isArray(message.toolCalls)&&message.toolCalls.length)assistant.tool_calls=message.toolCalls.map(call=>({id:call.modelId??call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
   result.push(assistant);
  }else if(message.role==='tool'){
   if(typeof message.toolCallId!=='string'||!message.toolCallId||typeof (message.modelToolCallId??message.toolCallId)!=='string')throw Error('Invalid branch tool result route');
   const blocks=toolBlocks(message.content);
   images.push(...blocks.filter(block=>block.type==='image').map(block=>({type:'image_url',image_url:{url:`data:${block.mimeType};base64,${block.data}`}})));
   result.push({role:'tool',tool_call_id:message.modelToolCallId??message.toolCallId,content:blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n')});
  }else throw Error('Invalid branch history role');
 }
 flush();return result;
}
function validSchema(schema,value,where='arguments'){
 if(!schema||typeof schema!=='object')return;
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`Invalid tool ${where}`);
  const properties=schema.properties??{};
  for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Error(`Missing tool ${where}.${key}`);
  if(schema.additionalProperties===false)for(const key of Object.keys(value))if(!Object.hasOwn(properties,key))throw Error(`Unexpected tool ${where}.${key}`);
  for(const [key,child] of Object.entries(properties))if(Object.hasOwn(value,key))validSchema(child,value[key],where+'.'+key);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||(schema.minLength!==undefined&&value.length<schema.minLength)||(schema.maxLength!==undefined&&value.length>schema.maxLength))throw Error(`Invalid tool ${where}`);
 }else if(schema.type==='integer'){
  if(!Number.isInteger(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum))throw Error(`Invalid tool ${where}`);
 }else if(schema.type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum))throw Error(`Invalid tool ${where}`);
 }else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error(`Invalid tool ${where}`);
 else if(schema.type==='array'){
  if(!Array.isArray(value)||(schema.minItems!==undefined&&value.length<schema.minItems)||(schema.maxItems!==undefined&&value.length>schema.maxItems))throw Error(`Invalid tool ${where}`);
  if(schema.items)for(const item of value)validSchema(schema.items,item,where+'[]');
 }
}
function normalizeToolResult(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Tool returned an invalid result');
 return {content:toolBlocks(value.content),details:value.details&&typeof value.details==='object'?copy(value.details):{},isError:value.isError===true};
}

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
 constructor(session,{fetchFn=fetch,guard=()=>{},snapshot,tools,broker}={}){
  super();this.session=session;this.fetch=fetchFn;this.guard=guard;this.options={tools,broker};
  this.file=path.join(session.store.root,'btw-branch.json');
  this.data=snapshot??(fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):null);
  if(!this.data)throw Error('没有可恢复的分支');
  if(this.data.version!==1||this.data.snapshot?.taskId!==session.task.id||!Array.isArray(this.data.history)||!Array.isArray(this.data.snapshot.body?.messages))throw Error('分支记录无效或不属于当前题目');
  const origin=new URL(this.data.snapshot.baseUrl);
  if(origin.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname))throw Error('分支模型服务必须使用本机 HTTP 地址');
  let migrated=false;
  if(!validBranchId(this.data.branchId)){this.data.branchId=fallbackBranchId(session,this.data);migrated=true;}
  if(!Number.isSafeInteger(this.data.nextRequestId)||this.data.nextRequestId<1){this.data.nextRequestId=1;migrated=true;}
  if(!Array.isArray(this.data.queuedInputs)){this.data.queuedInputs=[];migrated=true;}
  if(typeof this.data.knowledgeEnabled!=='boolean'){this.data.knowledgeEnabled=session.knowledgeControls?.().enabled??(session.config.knowledgeEnabled!==false);migrated=true;}
  this.toolRoot=path.join(session.store.root,'btw-tools',this.data.branchId);
  this.toolStore=new Store(this.toolRoot);
  if(broker?.store===session.store)throw Error('分支工具不得复用主线 Store');
  this._toolBroker=broker;this._tools=null;
  const self=this;
  this.broker={
   get config(){return self._toolBroker?.config??self.session.config?.sandbox??{};},
   validate:(...args)=>self.toolBroker().validate(...args),
   checkCommand:(...args)=>self.toolBroker().checkCommand(...args),
   start:(...args)=>self.toolBroker().start(...args),
   read:(...args)=>self.toolBroker().read(...args),
   readFile:(...args)=>self.toolBroker().readFile(...args),
   image:(...args)=>self.toolBroker().image(...args),
   jobStorageId:(...args)=>self.toolBroker().jobStorageId(...args)
  };
  this.status='idle';this.live=null;this.controller=null;this.running=null;this.error='';this.destroyed=false;this.releasing=false;
  if(migrated)this.save();
  if(!this.toolStore.events.some(e=>e.type==='btw_branch_opened'&&e.data.branch_id===this.data.branchId))this.toolStore.append('btw_branch_opened',{branch_id:this.data.branchId,task_id:session.task.id,snapshot_request_id:this.data.snapshot.requestId,route:'branch'});
 }
 static create(session,options={}){
  const branchId=options.branchId??newBranchId();if(!validBranchId(branchId))throw Error('Invalid branch identity');
  const data={version:1,branchId,nextRequestId:1,snapshot:snapshotBtw(session),history:[],createdAt:Date.now(),kvMayExist:false};
  const branch=new BtwSession(session,{...options,snapshot:data});branch.save();return branch;
 }
 save(){atomic(this.file,this.data);this.emit('change');}
 toolBroker(){
  if(!this._toolBroker){
   if(!this.session.config?.sandbox)throw Error('分支工具需要受管题目沙箱');
   this._toolBroker=new DockerBroker(this.session.config.sandbox,this.toolStore);
  }
  return this._toolBroker;
 }
 tools(){
  if(this._tools)return this._tools;
  // Never call InteractiveSession.tools(): its dependency tracker feeds
  // asynchronous observations into the primary session inbox.
  const all=this.options.tools??buildTools(this.toolStore,this.broker,this.session.knowledge??{},{submit:()=>{throw Error('submit_flag is unavailable in a branch');}},()=>{},
   {knowledgeEnabled:this.data.knowledgeEnabled,nativeImages:this.session.config.nativeImages===true,remainingMs:()=>this.session.budget?.().millisecondsRemaining??3600000,signal:()=>this.controller?.signal});
  if(!Array.isArray(all))throw Error('Invalid branch tool configuration');
  const names=new Set();
  this._tools=all.filter(tool=>tool?.name!=='submit_flag'&&(this.data.knowledgeEnabled||tool?.name!=='knowledge')&&(this.session.config.nativeImages===true||tool?.name!=='view_image')).map(tool=>{
   if(!tool||typeof tool.name!=='string'||!tool.name||typeof tool.description!=='string'||!tool.parameters||typeof tool.execute!=='function'||names.has(tool.name))throw Error('Invalid branch tool configuration');
   names.add(tool.name);return tool;
  });
  return this._tools;
 }
 toolMap(){return new Map(this.tools().map(tool=>[tool.name,tool]));}
 toolSpecs(){return this.tools().map(({name,description,parameters})=>({type:'function',function:{name,description,parameters:copy(parameters)}}));}
 messages(){return this.data.history.map(message=>{
  if(message.role==='assistant')return {role:'assistant',content:[...(message.reasoning?[{type:'thinking',thinking:message.reasoning}]:[]),...(message.content?[{type:'text',text:message.content}]:[]),...((message.toolCalls??[]).map(call=>({type:'toolCall',id:call.id,name:call.name,arguments:copy(call.arguments)})))],timestamp:message.time,harnessOperatorInterrupted:message.interrupted};
  if(message.role==='tool')return {role:'toolResult',toolCallId:message.toolCallId,toolName:message.toolName,content:toolBlocks(message.content),details:copy(message.details??{}),isError:message.isError===true,timestamp:message.time};
  return {role:'user',content:[{type:'text',text:message.content}],timestamp:message.time,harnessOperatorInterrupted:message.interrupted};
 });}
 activeOn(origin){return Boolean(this.running)&&this.data.snapshot.baseUrl===origin;}
 pendingToolCalls(){
  let group=null;
  for(const message of this.data.history){
   if(message.role==='assistant'&&Array.isArray(message.toolCalls)&&message.toolCalls.length){
    if(group)throw Error('分支工具历史不完整');
    const ids=new Set();
    for(const call of message.toolCalls){
     if(!call||typeof call.id!=='string'||!call.id||typeof (call.modelId??call.id)!=='string'||!(call.modelId??call.id)||typeof call.name!=='string'||!call.name||!call.arguments||typeof call.arguments!=='object'||Array.isArray(call.arguments)||ids.has(call.id))throw Error('分支工具历史无效');
     ids.add(call.id);
    }
    group={calls:message.toolCalls,answered:new Set()};continue;
   }
   if(message.role==='tool'){
    if(!group||typeof message.toolCallId!=='string'||!group.calls.some(call=>call.id===message.toolCallId)||group.answered.has(message.toolCallId))throw Error('分支工具历史不完整');
    group.answered.add(message.toolCallId);continue;
   }
   if(group&&group.answered.size!==group.calls.length)throw Error('分支工具历史不完整');
   group=null;
  }
  return group?group.calls.filter(call=>!group.answered.has(call.id)):[];
 }
 requestBody(){
  if(this.pendingToolCalls().length)throw Error('分支存在未路由的工具结果');
  // Finish/recover calls using the contract advertised to that request. Apply
  // the task's current setting only before constructing the next request.
  const enabled=this.session.knowledgeControls?.().enabled??(this.session.config.knowledgeEnabled!==false);
  if(enabled!==this.data.knowledgeEnabled){this.data.knowledgeEnabled=enabled;this._tools=null;this.save();}
  const s=this.data.snapshot,b=copy(s.body),tools=this.toolSpecs();
  for(const key of ['response_format','stream_options','id_slot','n_predict'])delete b[key];
  // Retain the accepted main request as the prefix so unified KV sharing is
  // not thrown away merely to explain the branch routing boundary.
  const instruction={role:'user',content:`[Harness routing notice: independent /btw branch ${this.data.branchId}. Tool calls and results stay in this branch and never modify or appear in the primary session. Use only listed tools; submit_flag is unavailable.${this.session.options?.communicationPrompt?.()?' Peer communication in the prefix belongs to the main session. This branch cannot call communicate and receives no new peer messages.':''} Offline knowledge is ${enabled?'enabled':'disabled'} for this task.]`};
  b.messages.push(instruction,...rawHistory(this.data.history));b.tools=tools;
  return {...b,model:s.model,id_slot:1,tool_choice:tools.length?'auto':'none',parallel_tool_calls:false,cache_prompt:true,max_tokens:s.generationTokens};
 }
 async json(route,{method='GET',body,signal,timeout=10000}={}){
  this.guard();signal?.throwIfAborted();
  const response=await this.fetch(this.data.snapshot.baseUrl+route,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
   headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  if(!response.ok){const detail=await response.text();const error=Error(`后端 HTTP ${response.status}: ${detail.slice(0,1000)}`);error.wait=detail.includes('CTF_BTW_WAIT');throw error;}
  return response.json();
 }
 reserveRequest(){
  const requestId=this.data.nextRequestId++;
  if(!Number.isSafeInteger(requestId)||requestId<1)throw Error('分支请求 ID 已耗尽');
  this.save();return requestId;
 }
 branchCallId(requestId,index){return `btw-${this.data.branchId}-r${requestId}-c${index}`;}
 parseToolCalls(drafts,requestId){
  const seenNative=new Set(),known=this.toolMap(),result=[];
  for(const [index,draft] of [...drafts].sort((a,b)=>a[0]-b[0])){
   let args={},invalidArguments=false;try{args=JSON.parse(draft.arguments);}catch{invalidArguments=true;}
   if(!args||typeof args!=='object'||Array.isArray(args)){args={};invalidArguments=true;}
   if(!draft.id||!draft.name||seenNative.has(draft.id))throw Error('Invalid complete branch tool call');
   const tool=known.get(draft.name);
   if(tool)try{validSchema(tool.parameters,args);}catch{invalidArguments=true;}
   seenNative.add(draft.id);
   result.push({id:this.branchCallId(requestId,index),modelId:draft.id,name:draft.name,arguments:args,unavailable:!tool,invalidArguments,native_id_sha256:hash(draft.id),native_index:index,requestId});
  }
  return result;
 }
 recordToolResult(call,result,{status='completed'}={}){
  if(this.data.history.some(message=>message.role==='tool'&&message.toolCallId===call.id))return;
  const record={role:'tool',toolCallId:call.id,modelToolCallId:call.modelId??call.id,toolName:call.name,content:copy(result.content),details:copy(result.details??{}),isError:result.isError===true,time:Date.now()};
  this.data.history.push(record);this.save();
  this.toolStore.append('btw_tool_result',{branch_id:this.data.branchId,task_id:this.session.task.id,request_id:call.requestId,tool_call_id:call.id,model_tool_call_id_sha256:hash(record.modelToolCallId),tool_name:call.name,status,is_error:record.isError,content_sha256:hash(JSON.stringify(record.content)),route:'branch'});
 }
 async executeTool(call,signal){
  const tool=this.toolMap().get(call.name);let result,status='completed';
  if(signal?.aborted){
   result={content:[{type:'text',text:'This branch was paused before the tool call was executed.'}],details:{branch_id:this.data.branchId,execution_status:'cancelled_before_execution'},isError:true};status='cancelled';
  }else if(call.invalidArguments){
   result={content:[{type:'text',text:'The model supplied invalid arguments for this branch tool, so it was not executed.'}],details:{branch_id:this.data.branchId,execution_status:'invalid_arguments'},isError:true};status='invalid_arguments';
  }else if(!tool){
   result={content:[{type:'text',text:`Tool ${call.name} is unavailable in this branch and was not executed.`}],details:{branch_id:this.data.branchId,execution_status:'not_available'},isError:true};status='unavailable';
  }else try{
   validSchema(tool.parameters,call.arguments);
   this.toolStore.append('btw_tool_dispatch',{branch_id:this.data.branchId,task_id:this.session.task.id,request_id:call.requestId,tool_call_id:call.id,model_tool_call_id_sha256:hash(call.modelId??call.id),tool_name:call.name,route:'branch'});
   result=normalizeToolResult(await tool.execute(call.id,copy(call.arguments),signal));
  }catch(error){
   const started=this.toolStore.events.find(e=>e.type==='tool_start'&&e.data.callId===call.id),done=this.toolStore.events.find(e=>e.type==='tool_done'&&e.data.callId===call.id);
   const message=signal?.aborted?'The branch was paused while this tool was running. Its result is unknown; do not assume the action was retried.':toolError(this.toolStore,call.name,call.id,error);
   result={content:[{type:'text',text:message}],details:{branch_id:this.data.branchId,execution_status:started&&!done?'unknown_after_interruption':'failed_before_execution'},isError:true};status=started&&!done?'unknown':'error';
   if(started&&!done){
    this.toolStore.append('btw_tool_unknown_outcome',{branch_id:this.data.branchId,request_id:call.requestId,tool_call_id:call.id,tool_name:call.name,executed_again:false,route:'branch'});
    this.toolStore.append('tool_done',{callId:call.id,result});
   }
  }
  this.recordToolResult(call,result,{status});
 }
 async executePendingTools(signal){
  const calls=this.pendingToolCalls();
  for(const call of calls){
   await this.executeTool(call,signal);
   if(signal?.aborted){
    for(const pending of this.pendingToolCalls())await this.executeTool(pending,signal);
    signal.throwIfAborted();
   }
  }
 }
 async stream(body,count,requestId,signal){
  this.guard();this.data.kvMayExist=true;this.save();
  this.toolStore.append('btw_model_request',{branch_id:this.data.branchId,task_id:this.session.task.id,request_id:requestId,prompt_tokens:count.input_tokens,body_sha256:hash(JSON.stringify(body)),route:'branch'});
  const response=await this.fetch(this.data.snapshot.baseUrl+'/v1/chat/completions',{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json'},body:JSON.stringify({...body,stream:true,stream_options:{include_usage:true}})});
  if(!response.ok){const detail=await response.text();const error=Error(`分支请求失败 HTTP ${response.status}: ${detail.slice(0,1000)}`);error.wait=detail.includes('CTF_BTW_WAIT');throw error;}
  this.toolStore.append('btw_model_accepted',{branch_id:this.data.branchId,request_id:requestId,route:'branch'});
  this.status='generating';this.emit('change');
  let content='',reasoning='',buffer='',finish=null,done=false,usage=null;const drafts=new Map(),decoder=new TextDecoder();
  const partial=()=>({content,reasoning,drafts,requestId});
  const line=value=>{
   if(!value.startsWith('data:'))return;
   const payload=value.slice(5).trim();if(payload==='[DONE]'){done=true;return;}
   const chunk=JSON.parse(payload);if(chunk.error){const error=Error(JSON.stringify(chunk.error));error.wait=error.message.includes('CTF_BTW_WAIT');throw error;}
   if(chunk.usage)usage=chunk.usage;
   const choice=chunk.choices?.[0];if(!choice)return;
   if(choice.finish_reason)finish=choice.finish_reason;
   const delta=choice.delta??{};
   // llama-server emits content:null in its initial assistant-role frame.
   // Null means no text in this frame, just like an omitted field.
   if(delta.content!=null){if(typeof delta.content!=='string')throw Error('Invalid branch content delta');content+=delta.content;}
   if(delta.reasoning_content!=null){if(typeof delta.reasoning_content!=='string')throw Error('Invalid branch reasoning delta');reasoning+=delta.reasoning_content;}
   for(const call of delta.tool_calls??[]){
    if(!call||!Number.isSafeInteger(call.index)||call.index<0)throw Error('Invalid branch tool-call delta');
    let draft=drafts.get(call.index);if(!draft){draft={id:'',name:'',arguments:''};drafts.set(call.index,draft);}
    if(call.id!==undefined){if(typeof call.id!=='string')throw Error('Invalid branch tool-call ID');draft.id=call.id;}
    if(call.function?.name!==undefined){if(typeof call.function.name!=='string')throw Error('Invalid branch tool-call name');draft.name+=call.function.name;}
    if(call.function?.arguments!==undefined){if(typeof call.function.arguments!=='string')throw Error('Invalid branch tool-call arguments');draft.arguments+=call.function.arguments;}
   }
   if(content||reasoning)this.live={role:'assistant',content:[...(reasoning?[{type:'thinking',thinking:reasoning}]:[]),...(content?[{type:'text',text:content}]:[])]};this.emit('change');
  };
  try{
   for await(const bytes of streamChunks(response.body,signal)){buffer+=decoder.decode(bytes,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}}
   buffer+=decoder.decode();if(buffer.trim())line(buffer.trimEnd());signal.throwIfAborted();
  }catch(error){error.btwPartial=partial();throw error;}
  if(!done||!usage||usage.prompt_tokens!==count.input_tokens||!Number.isInteger(usage.completion_tokens)||usage.completion_tokens<0||usage.completion_tokens>body.max_tokens||!['stop','tool_calls','length'].includes(finish))throw Error('分支响应不完整或 token 统计不匹配');
  if(finish==='length'){
   this.toolStore.append('btw_model_response',{branch_id:this.data.branchId,request_id:requestId,finish,tool_drafts:drafts.size,native_usage:usage,route:'branch'});
   return {content,reasoning,calls:[],drafts,finish,usage,requestId};
  }
  const calls=this.parseToolCalls(drafts,requestId);
  if((finish==='tool_calls')!==Boolean(calls.length))throw Error('分支工具调用结束状态不匹配');
  this.toolStore.append('btw_model_response',{branch_id:this.data.branchId,request_id:requestId,finish,tool_calls:calls.map(call=>({tool_call_id:call.id,model_tool_call_id_sha256:hash(call.modelId),tool_name:call.name})),native_usage:usage,route:'branch'});
  return {content,reasoning,calls,drafts,finish,usage,requestId};
 }
 discardToolDrafts(partial,reason){
  if(partial?.drafts?.size)this.toolStore.append('btw_tool_drafts_discarded',{branch_id:this.data.branchId,request_id:partial.requestId,count:partial.drafts.size,reason,executed:false,route:'branch'});
 }
 persistPartial(partial,{continuation=false}={}){
  if(!partial||(!partial.content&&!partial.reasoning))return;
  this.data.history.push({role:'assistant',content:partial.content,reasoning:partial.reasoning,time:Date.now(),interrupted:true});
  if(continuation)this.data.history.push({role:'user',content:'请继续刚才因 KV 余量不足而暂停的回答。',time:Date.now()});
  this.save();
 }
 async finishInput(signal){
  this.live=null;
  if(this.data.queuedInputs.length)return this.generate(signal);
  this.status='idle';this.save();
 }
 ask(text){
  if(this.running)throw Error('分支正在生成或等待 KV；可先按 Ctrl+C 暂停');
  if(this.releasing)throw Error('分支 KV 正在释放，请稍后再试');
  if(this.destroyed)throw Error('分支已删除');
  if(typeof text!=='string'||!text.trim())throw Error('请输入分支问题');
  if(this.session.config.model!==this.data.snapshot.model||this.session.config.baseUrl!==this.data.snapshot.baseUrl)throw Error('主线模型已改变，请切回原模型或删除分支');
  this.data.queuedInputs.push({id:crypto.randomUUID(),text,time:Date.now()});this.save();
  this.controller=new AbortController();this.status='waiting';this.error='';
  const run=this.generate(this.controller.signal).finally(()=>{if(this.running===run){this.running=null;this.controller=null;this.emit('change');}});
  this.running=run;run.catch(()=>{});
  this.emit('change');return run;
 }
 async generate(signal){
  let required=0,requiredAt=null,partial=null,activeRequestId=null;
  try {
   await this.executePendingTools(signal);signal.throwIfAborted();
   const queued=this.data.queuedInputs.shift();
   if(!queued){this.status='idle';this.save();return;}
   if(typeof queued.text!=='string'||!queued.text.trim())throw Error('分支输入队列无效');
   this.data.history.push({role:'user',content:queued.text,time:queued.time});this.save();
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
    const requestId=this.reserveRequest();activeRequestId=requestId;let result;
    try{result=await this.stream(body,count,requestId,signal);partial=null;}
    catch(error){
     partial=error.btwPartial??partial;
     if(!error.wait||signal.aborted)throw error;
     this.discardToolDrafts(partial,'kv_preempted');this.persistPartial(partial,{continuation:true});partial=null;
     required=Number(/required=(\d+)/.exec(error.message)?.[1]??0);requiredAt=Number.isSafeInteger(main?.retained_tokens)?{tokens:main.retained_tokens,state:main.state}:null;
     this.status='waiting';this.live=null;this.emit('change');await delay(1000,undefined,{signal});continue;
    }
    required=0;requiredAt=null;
    if(result.finish==='length'){
     this.discardToolDrafts(result,'generation_output_limit');
     const content=result.content||'[Generation reached its output limit before completing a tool call. No tool calls were executed.]';
     this.data.history.push({role:'assistant',content,reasoning:result.reasoning,time:Date.now(),truncated:true});
     return this.finishInput(signal);
    }
    if(result.calls.length){
     this.data.history.push({role:'assistant',content:result.content,reasoning:result.reasoning,toolCalls:result.calls,time:Date.now()});this.save();
     this.live={role:'assistant',content:[...(result.reasoning?[{type:'thinking',thinking:result.reasoning}]:[]),...(result.content?[{type:'text',text:result.content}]:[]),...result.calls.map(call=>({type:'toolCall',id:call.id,name:call.name,arguments:copy(call.arguments)}))]};this.emit('change');
     await this.executePendingTools(signal);this.live=null;continue;
    }
    if(!result.content)throw Error('分支响应为空');
    this.data.history.push({role:'assistant',content:result.content,reasoning:result.reasoning,time:Date.now()});
    return this.finishInput(signal);
   }
  }catch(error){
   this.discardToolDrafts(partial,signal.aborted?'cancelled':'stream_error');this.persistPartial(partial);
   this.toolStore.append(signal.aborted?'btw_generation_paused':'btw_generation_failed',{
    branch_id:this.data.branchId,task_id:this.session.task.id,request_id:activeRequestId,
    error:signal.aborted?'Cancelled by operator':String(error.message??error),route:'branch'});
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
   this.data.kvMayExist=false;this.status='idle';this.error='';this.save();
   this.toolStore.append('btw_kv_released',{branch_id:this.data.branchId,task_id:this.session.task.id,slot:1,route:'branch'});return result;
  }finally{this.releasing=false;}
 }
 async destroy(){
  await this.free();this.destroyed=true;
  this.toolStore.append('btw_branch_closed',{branch_id:this.data.branchId,task_id:this.session.task.id,route:'branch'});
  fs.rmSync(this.file,{force:true});this.emit('change');
 }
}
