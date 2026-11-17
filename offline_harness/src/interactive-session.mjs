import fs from 'node:fs';
import path from 'node:path';
import {taskClock,beginSolve,endSolve,checkpointSolve,stopReserveMs,processIdentity} from './task-clock.mjs';
import {outputLimitContinuation} from './truncation.mjs';
import {EventEmitter} from 'node:events';
import {Agent} from '@earendil-works/pi-agent-core';
import {createInitialSystemMessage} from '@earendil-works/pi-ai';
import {generationSettings,effortSettings} from './generation-controls.mjs';
import {Store,hash} from './store.mjs';
import {TaskInbox} from './inbox.mjs';
import {NativeClient,assertExperimentIdle} from './native.mjs';
import {DockerBroker} from './broker.mjs';
import {Skills} from './skills.mjs';
import {buildTools} from './tools.mjs';
import {presentMessages,commandOutput,boundedText,recordCursor} from './tool-output.mjs';
import {systemPrompt,validateTask} from './runner.mjs';
import {groups} from './context.mjs';
import {recoverInterruptedTools} from './resume-tools.mjs';
import {LocalModelRecovery} from './local-model.mjs';

export const SESSION_DEFAULTS={runtimeProtocol:'native-read-compact-v3',mode:'memory-skills',model:'qwen3.8-27b-iq4xs',baseUrl:'http://127.0.0.1:8080',contextTokens:65536,promptTokens:51200,generationTokens:8192,reasoningTokens:4096,maxTurns:200,maxGeneratedTokens:262144,maxSeconds:2400,budgetMode:'active_solve',nativeImages:false};
export class InteractiveSession extends EventEmitter {
 constructor(task,config,options={}){
  super();validateTask(task);this.task=task;this.config={...SESSION_DEFAULTS,...config};this.options=options;
  for(const k of ['contextTokens','promptTokens','generationTokens','maxTurns','maxGeneratedTokens','maxSeconds'])if(!Number.isInteger(this.config[k])||this.config[k]<1)throw Error('Invalid budget '+k);
  if(!Number.isInteger(this.config.reasoningTokens)||(this.config.reasoningTokens!==-1&&this.config.reasoningTokens<1))throw Error('Invalid budget reasoningTokens');
  if(this.config.promptTokens+this.config.generationTokens+64>this.config.contextTokens||this.config.reasoningTokens>=this.config.generationTokens)throw Error('Invalid context/output reserve');
  this.store=options.store||new Store(config.runDir);this.inbox=new TaskInbox(task.id,this.store);
  const existing=this.store.events.find(e=>e.type==='interactive_task');
  const frozen={task,config:this.config};
  if(existing&&existing.data.sha256!==hash(JSON.stringify(frozen)))throw Error('Task/config differs from durable session');
  if(!existing)this.store.append('interactive_task',{...frozen,sha256:hash(JSON.stringify(frozen))});
  this.compactProfile={compactReasoningEffort:this.config.compactReasoningEffort??this.config.reasoningEffort??'medium',compactReasoningTokens:this.config.compactReasoningTokens??4096};
  this.applyEffort();this.replayModel();
  this.broker=options.broker||new DockerBroker(this.config.sandbox,this.store);
  this.knowledge=options.knowledge||new Skills(this.config.skillsDir);
  this.remote=options.remote||{};this.status='idle';this.agent=null;this.pauseRequested=false;this.yieldRequested=false;
  this.guard=options.guard||assertExperimentIdle;this.pollErrors=new Map();
  this.localModel=options.localRecovery??(this.config.localRecovery?new LocalModelRecovery(this.config.localRecovery,this.store):null);
  this.recoverObservations();
  const originalAppend=this.store.append.bind(this.store);
  this.store.append=(type,data)=>{const e=originalAppend(type,data);this.emit('journal',e);return e;};
 }
 messages(){return presentMessages(this.store,this.broker,this.store.events.filter(e=>e.type==='message').map(e=>e.data).filter(m=>m.role!=='assistant'||!['error','aborted'].includes(m.stopReason)));}
 enqueue(text,options){const item=this.inbox.enqueue(text,options);this.emit('change');return item;}
 budget(exclude){
  const requests=this.store.events.filter(e=>e.type==='model_request'&&e.data.requestId!==exclude);
  const generated=requests.reduce((n,e)=>n+(this.store.events.find(x=>x.type==='model_usage'&&x.data.requestId===e.data.requestId)?.data.completion_tokens??e.data.body.max_tokens),0);
  const activeMs=this.store.events.filter(e=>e.type==='slice_start').reduce((n,e)=>n+(this.store.events.find(x=>x.type==='slice_end'&&x.data.start===e.seq)?.data.elapsedMs??(Date.now()-e.time)),0);
  return {turns:requests.length,generated,turnsRemaining:Math.max(0,this.config.maxTurns-requests.length),tokensRemaining:Math.max(0,this.config.maxGeneratedTokens-generated),millisecondsRemaining:taskClock(this.store,this.config).millisecondsRemaining,wall:taskClock(this.store,this.config),processingMilliseconds:activeMs};
 }
 dependencies(){
  const done=new Set(this.store.events.filter(e=>e.type==='dependency_done').map(e=>e.data.key));
  return this.store.events.filter(e=>e.type==='dependency_started'&&!done.has(e.data.key)).map(e=>e.data);
 }
 trackDependency(kind,id){const key=kind+':'+id;if(!this.dependencies().some(x=>x.key===key))this.store.append('dependency_started',{kind,id,key});}
 candidates(){
  return this.store.events.filter(e=>e.type==='candidate').map((e,index)=>({...e.data,review_id:'c'+(index+1),feedback:this.store.events.filter(f=>f.type==='platform_feedback'&&f.data.id===e.data.id).at(-1)?.data}));
 }
 feedback(id,status,note=''){
  if(!['correct','incorrect','pending'].includes(status))throw Error('Judge feedback must be correct/incorrect/pending');
  const candidate=this.candidates().find(x=>x.id===id||x.review_id===id);if(!candidate)throw Error('Candidate belongs to a different task or is unknown');
  if(candidate.feedback&&candidate.feedback.status!=='pending')throw Error('This candidate already has final feedback');
  id=candidate.id;this.store.append('platform_feedback',{id,status,note:String(note).slice(0,2000),taskId:this.task.id});
  if(status==='correct'){this.store.append('task_clock_end',{status:'correct'});this.status='correct';this.pauseRequested=true;this.agent?.abort();}
  else if(status==='incorrect')this.enqueue('Competition platform feedback: '+candidate.candidate+' is incorrect. '+String(note).slice(0,2000),{kind:'feedback'});
  this.emit('change');
 }
 pause({immediate=true}={}){this.pauseRequested=true;if(immediate)this.operatorController?.abort();this.emit('change');}
 replayModel(){const last=this.store.events.findLast(e=>e.type==='model_changed');if(last)Object.assign(this.config,last.data.settings);}
 selectModel(settings,receipt){
  if(this.running)throw Error('Wait for the interrupted round to finish before switching models');
  this.store.append('model_changed',{from:{model:this.config.model,baseUrl:this.config.baseUrl},settings,receipt});Object.assign(this.config,settings);
  this.localModel=this.config.localRecovery?new LocalModelRecovery(this.config.localRecovery,this.store):null;this.emit('change');
 }
 generationControls(){return {current:generationSettings(this.config),pending:this.pendingControl('effort')?.data.settings,compact:this.pendingControl('compact')?.seq??null};}
 pendingControl(kind){return this.store.events.findLast(e=>e.type===kind+'_requested'&&!this.store.events.some(x=>x.type===kind+'_resolved'&&x.data.request_seq===e.seq));}
 requestEffort(level,budget){
  const settings=effortSettings(level,budget,this.pendingControl('effort')?.data.settings??generationSettings(this.config),this.config);
  const request=this.store.append('effort_requested',{settings});if(!this.running)this.applyEffort();this.emit('change');return {settings,pending:this.running,request_seq:request.seq};
 }
 applyEffort(){
  // Replay the latest settings without changing the frozen interactive_task configuration.
  const last=this.store.events.findLast(e=>e.type==='effort_requested');if(last)Object.assign(this.config,last.data.settings);
  for(const e of this.store.events.filter(e=>e.type==='effort_requested'&&!this.store.events.some(x=>x.type==='effort_resolved'&&x.data.request_seq===e.seq)))this.store.append('effort_resolved',{request_seq:e.seq,status:e===last?'applied':'superseded'});
 }
 requestCompact(){const prior=this.pendingControl('compact');const request=prior??this.store.append('compact_requested',{});this.emit('change');return {request_seq:request.seq,pending:true};}
 async compactRequested(client,messages,signal){
  const request=this.pendingControl('compact');if(!request||this.pauseRequested)return;
  this.applyEffort();Object.assign(client.config,generationSettings(this.config));
  this.emit('auxiliary',{kind:'compact',status:'running'});
  try {const result=await client.compactNow(messages,signal);this.store.append('compact_resolved',{request_seq:request.seq,status:result.status});return result;}
  catch(error){this.store.append('compact_resolved',{request_seq:request.seq,status:signal?.aborted?'interrupted':'failed',error:error.message});if(signal?.aborted)throw error;return {status:'failed',error:error.message};}
  finally{this.emit('auxiliary',{kind:'compact',status:'idle'});this.emit('change');}
 }
 systemPrompt(){return systemPrompt(this.config.mode,this.knowledge)+'\nThis is a persistent interactive competition session. A normal final response waits for the operator. Human corrections remain pinned until the operator archives them. submit_flag saves a candidate for the operator to submit. The frontend shows awaiting_review until the operator records correct or incorrect feedback.';}

 requestYield(){this.yieldRequested=true;}
 async cancelCommand(id){
  if(!this.store.events.some(e=>e.type==='job_started'&&e.data.job_id===id))throw Error('Command does not belong to this task');
  const result=await this.broker.cancel(id);this.store.append('command_cancel_requested',{job_id:id,result});return result;
 }
 tools(){
  const verdict={submit:(callId,candidate)=>{
   const id=hash(this.task.id+'\0'+callId);const old=this.candidates().find(x=>x.id===id);
   if(!old)this.store.append('candidate',{id,taskId:this.task.id,candidate});
   return {submission_id:id,review_id:this.candidates().find(x=>x.id===id).review_id,status:'awaiting_review',message:'Saved for operator review in /queue.'};
  }};
  const tools=buildTools(this.store,this.broker,this.knowledge,verdict,()=>{}, {manualReview:true,nativeImages:this.config.nativeImages,remainingMs:()=>this.budget().millisecondsRemaining,signal:()=>this.requestSignal});
  const wrap=tools.map(tool=>({...tool,execute:async(id,args,...rest)=>{
   const result=await tool.execute(id,args,...rest);
   if(['run_command','wait_job'].includes(tool.name)){
    const job=result.details;
    if(!['finished','cancelled','unknown_exit'].includes(job?.job_status)){
     const id=job?.job_id||this.store.events.findLast(e=>e.type==='job_started')?.data.job_id;
     if(id&&tool.name==='run_command')this.trackDependency('command',id);
    }else{const dep=this.dependencies().find(x=>x.kind==='command'&&x.id===job.job_id);if(dep)this.store.append('dependency_done',{...dep,result_status:job.job_status,observed:true});}

   }
   return result;
  }}));
  for(const [kind,client] of Object.entries(this.remote)){
   const name=kind==='rag'?'rag_search':'analyze_image';
   wrap.push({name,label:name,description:kind==='rag'?'Start asynchronous search of the configured local reference corpus. Results have source citations.':'Start asynchronous image analysis on the configured LAN vision service.',
    parameters:{type:'object',properties:kind==='rag'?{query:{type:'string',minLength:1,maxLength:2000}}:{path:{type:'string',minLength:1,maxLength:500},question:{type:'string',minLength:1,maxLength:2000}},required:kind==='rag'?['query']:['path','question'],additionalProperties:false},
    execute:async(callId,args)=>this.store.execute(callId,name,args,async()=>{
     const requestId=hash(this.task.id+'\0'+callId);
     const request=kind==='rag'?{query:args.query,topK:5,mode:'hybrid',taskId:this.task.id,requestId}:{...args,image:await this.broker.image(args.path),taskId:this.task.id,requestId};
     const job=await client.submit(request);this.trackDependency(kind,job.jobId);
     const ref=this.store.put({jobId:job.jobId,status:job.status},'tool:'+name);
     return {content:[{type:'text',text:JSON.stringify({job_id:job.jobId,status:job.status})}],details:{}};
    })});
  }
  return wrap.filter(t=>(this.config.nativeImages||t.name!=='view_image'));
 }
 observation(result,kind,id){return boundedText(this.store,this.broker,JSON.stringify(kind==='command'?commandOutput(this.store,this.broker,result):result),kind+':'+id);}
 recoverObservations(){
  for(const e of this.store.events.filter(e=>e.type==='dependency_done'&&!e.data.observed)){
   const d=e.data,id='dependency-'+d.key;
   if(!this.inbox.items().some(i=>i.id===id)&&d.evidence_id){
    const result=JSON.parse(fs.readFileSync(path.join(this.store.root,'artifacts',d.evidence_id),'utf8'));
    this.enqueue(this.observation(result,d.kind,d.id),{id,kind:'observation'});
   }
  }
 }
 async collect(){
  if(this.config.budgetMode==='active_solve'&&this.solveSegment&&this.budget().millisecondsRemaining<=stopReserveMs(this.config)){this.pauseRequested=true;this.agent?.abort();for(const d of this.dependencies().filter(d=>d.kind==='command'))await this.broker.cancel(d.id);this.status='budget_exhausted';this.stopSolveClock('budget_exhausted');}
  this.recoverObservations();
  for(const dep of this.dependencies()){
   let result;
   try {
    if(dep.kind==='command'){const cursor=this.store.events.findLast(e=>e.type==='job_output_cursor'&&e.data.job_id===dep.id)?.data;result=await this.broker.read(dep.id,0,{stdoutOffset:cursor?.stdout_offset??0,stderrOffset:cursor?.stderr_offset??0});}
    else {const status=await this.remote[dep.kind].status(dep.id);if(['queued','running'].includes(status.status))continue;result=status.status==='completed'?await this.remote[dep.kind].result(dep.id):status;}
    if(['starting','running','queued','cancelling','terminating'].includes(result.status))continue;
    const ref=this.store.put(result,dep.kind==='command'?'tool:wait_job':'tool:'+dep.kind);
    if(dep.kind==='command')recordCursor(this.store,result,ref.id);
    this.store.append('dependency_done',{...dep,result_status:result.status,evidence_id:ref.id});
    this.enqueue(this.observation(result,dep.kind,dep.id),{id:'dependency-'+dep.key,kind:'observation'});
   }catch(error){if(dep.kind!=='command'&&error.status===404){const ref=this.store.put({status:'failed',error:{code:'JOB_NOT_FOUND',message:'Service job is missing or expired; do not assume retrieval succeeded.'}},'tool:'+dep.kind);this.store.append('dependency_done',{...dep,result_status:'failed',evidence_id:ref.id});this.recoverObservations();continue;}const prior=this.pollErrors.get(dep.key);if(!prior||prior.error!==error.message||Date.now()-prior.time>60000){this.store.append('dependency_poll_error',{...dep,error:error.message});this.pollErrors.set(dep.key,{error:error.message,time:Date.now()});}}
  }
  if(!this.agent&&!this.dependencies().length)this.stopSolveClock('no_active_tool_or_inference');
  return this.dependencies();
 }
 stopSolveClock(reason){endSolve(this.store,this.config,this.solveSegment,reason);clearInterval(this.solveHeartbeat);this.solveHeartbeat=null;this.solveSegment=null;}
 async runSlice({maintenanceOnly=false}={}){
  if(this.running)throw Error('Session already running');
  if(maintenanceOnly&&this.messages().filter(m=>m.role!=='system').length<2){const request=this.pendingControl('compact');if(request)this.store.append('compact_resolved',{request_seq:request.seq,status:'no_history'});return {status:'awaiting_input',dependencies:this.dependencies(),budget:this.budget()};}
  this.running=true;this.pauseRequested=false;this.yieldRequested=false;this.operatorController=new AbortController();this.budgetController=new AbortController();this.requestSignal=AbortSignal.any([this.operatorController.signal,this.budgetController.signal]);this.budgetTimedOut=false;
  this.solveTimer=null;
  try{return await this.runActiveSlice({maintenanceOnly});}
  catch(error){if(this.budgetTimedOut){this.status='budget_exhausted';return {status:'budget_exhausted',dependencies:this.dependencies(),budget:this.budget()};}if(!this.operatorController.signal.aborted)throw error;this.status='paused';return {status:'paused',dependencies:this.dependencies(),budget:this.budget()};}
  finally{clearTimeout(this.solveTimer);this.running=false;this.agent=null;this.operatorController=null;if(!this.dependencies().length)this.stopSolveClock(this.pauseRequested?'paused':this.status);this.emit('change');}
 }
 async runActiveSlice({maintenanceOnly}){
  if(this.agent)throw Error('Session already running');
  if(this.candidates().some(x=>x.feedback?.status==='correct'))return {status:'correct'};
  this.guard();
  if(this.config.localRecovery){
   const owner=this.store.events.findLast(e=>e.type==='solve_segment_start');
   if(owner&&!this.store.events.some(e=>e.type==='solve_segment_end'&&e.data.start_seq===owner.seq)){
    const live=processIdentity(owner.data.owner.pid);
    if(live&&live.state!=='Z'&&live.start_ticks===owner.data.owner.start_ticks)throw Error('Session has another live solve owner');
   }
   const recovered=recoverInterruptedTools(this.store,{resolve:(callId)=>{
    const candidate=this.candidates().find(c=>c.id===hash(this.task.id+'\0'+callId));if(!candidate)throw Error('Candidate receipt unavailable');
    return {submission_id:candidate.id,review_id:candidate.review_id,status:candidate.feedback?.status??'awaiting_review'};
   }});
   if(recovered.awaitingJudge)return {status:'awaiting_judge',dependencies:this.dependencies(),budget:this.budget()};
  }
  if(this.store.pending().length)throw Error('Uncertain tool side effect requires review');
  taskClock(this.store,this.config,{start:true});
  const b=this.budget();if(!b.tokensRemaining||!b.turnsRemaining||b.millisecondsRemaining<=stopReserveMs(this.config))return {status:'budget_exhausted'};
  await this.broker.validate();this.operatorController.signal.throwIfAborted();this.applyEffort();
  const cfg={...this.config,...this.compactProfile,nativeSlot:this.config.kv?.slot??this.config.nativeSlot??0};
  const client=new NativeClient(cfg,this.store,{fetchFn:this.options.fetchFn||fetch,localRecovery:this.localModel,operatorSignal:this.operatorController.signal,requestSignal:this.requestSignal,onAuxiliary:event=>this.emit('auxiliary',event),onAccepted:e=>this.inbox.accepted(e),guard:({activeRequestId}={})=>{
   this.guard();if(this.pauseRequested)throw Error('Inference paused');
   const budget=this.budget(activeRequestId);if(!budget.turnsRemaining||!budget.tokensRemaining||budget.millisecondsRemaining<=stopReserveMs(this.config))throw Error('Run budget exhausted');
   Object.assign(cfg,generationSettings(this.config));cfg.generationTokens=Math.min(this.config.generationTokens,budget.tokensRemaining);cfg.reasoningTokens=this.config.reasoningTokens===-1?-1:Math.min(this.config.reasoningTokens,Math.max(1,cfg.generationTokens-1));
  }});
  await client.preflight(this.requestSignal);
  let messages=this.messages();
  if(!messages.length){const m={role:'user',content:JSON.stringify(this.task),timestamp:Date.now()};this.store.append('message',m);messages=[m];}
  messages=this.inbox.mount(messages);groups(messages.filter(m=>m.role!=='system'));
  if(messages.at(-1)?.harnessOutputTruncated){const continuation=outputLimitContinuation(this.store,messages.at(-1));this.store.append('message',continuation);messages.push(continuation);}
  messages=messages.filter(m=>m.role!=='system');messages.unshift(createInitialSystemMessage(this.systemPrompt(),this.tools().map(({name,description,parameters})=>({name,description,parameters}))));
  this.solveSegment=beginSolve(this.store,this.config);if(this.solveSegment&&!this.solveHeartbeat)this.solveHeartbeat=setInterval(()=>checkpointSolve(this.store,this.config,this.solveSegment),1000);if(this.solveHeartbeat)this.solveHeartbeat.unref();
  this.solveTimer=setTimeout(()=>{this.budgetTimedOut=true;this.pauseRequested=true;this.budgetController.abort();this.agent?.abort();},Math.max(0,this.budget().millisecondsRemaining-stopReserveMs(this.config)));
  await this.compactRequested(client,messages,this.requestSignal);
  if(maintenanceOnly){const result={status:'awaiting_input',dependencies:this.dependencies(),budget:this.budget()};this.status=result.status;return result;}
  if(messages.at(-1)?.harnessOperatorInterrupted){const lastEvent=this.store.events.findLast(e=>e.type==='message'&&e.data.harnessOperatorInterrupted);this.enqueue('Continue from the saved interrupted response. Its tool drafts were not executed. Inspect existing tool receipts before issuing a fresh call.',{id:'interrupt-'+lastEvent.seq,kind:'observation'});messages=this.inbox.mount(messages);}
  const last=messages.at(-1);
  if(last.role==='assistant'&&!last.content.some(x=>x.type==='toolCall'))return {status:'awaiting_input'};
  if(last.role==='assistant')throw Error('Unfinished tool call group requires review');
  const model={id:cfg.model,name:cfg.model,api:'openai-completions',provider:'local-qwen',baseUrl:cfg.baseUrl,reasoning:true,input:cfg.nativeImages?['text','image']:['text'],contextWindow:cfg.contextTokens,maxTokens:cfg.generationTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let outcome='ready';
  const agent=new Agent({initialState:{systemPrompt:this.systemPrompt(),model,tools:this.tools(),messages,thinkingLevel:cfg.reasoningEffort??'medium'},identity:{attribution:null},toolExecution:'sequential',streamFn:client.stream,
   prepareRequest:async({context})=>{this.applyEffort();Object.assign(cfg,generationSettings(this.config));return {context:{...context,messages:this.inbox.mount(context.messages)}};},
   beforeToolCall:()=>this.pauseRequested?{block:true,terminate:true,reason:'Operator paused inference; tool was not executed'}:this.store.pending().length?{block:true,terminate:true,reason:'Earlier tool outcome is uncertain'}:undefined,
   finishTurn:async({message,context})=>{
    if(this.pauseRequested){outcome=this.candidates().some(x=>x.feedback?.status==='correct')?'correct':this.budgetTimedOut?'budget_exhausted':'paused';return {action:'end'};}
    if(['error','aborted'].includes(message.stopReason)||this.store.pending().length){outcome='needs_review';return {action:'end'};}
    this.applyEffort();
    await this.compactRequested(client,context.messages,this.requestSignal);
    if(this.pauseRequested){outcome=this.budgetTimedOut?'budget_exhausted':'paused';return {action:'end'};}
    const remaining=this.budget();if(!remaining.tokensRemaining||!remaining.turnsRemaining){outcome='budget_exhausted';return {action:'end'};}
    if(this.yieldRequested){outcome='ready';return {action:'end'};}
    if(message.harnessTruncated)return {action:'continue'};
    if(message.harnessOutputTruncated){agent.followUp(outputLimitContinuation(this.store,message));return {action:'continue'};}
    if(message.stopReason==='stop'){
     if(this.inbox.items().some(x=>x.status==='queued'))return {action:'continue'};
     const deps=this.dependencies();outcome=deps.length?(deps.some(x=>x.kind==='command')?'waiting_tool':'waiting_service'):this.candidates().some(x=>!x.feedback||x.feedback.status==='pending')?'awaiting_review':'awaiting_input';return {action:'end'};
    }
   }});
  this.agent=agent;this.status='running';
  agent.subscribe(event=>{
   if(event.type==='message_end')this.store.append('message',event.message);
   this.emit('agent',event);this.emit('change');
  });
  const start=this.store.append('slice_start',{});
  try {await agent.continue();}
  finally {this.agent=null;if(!this.dependencies().length)this.stopSolveClock(outcome);this.store.append('slice_end',{start:start.seq,elapsedMs:Date.now()-start.time});}
  this.status=outcome;const result={status:outcome,dependencies:this.dependencies(),budget:this.budget()};this.store.snapshot('interactive-state',result);this.emit('change');return result;
 }
}
