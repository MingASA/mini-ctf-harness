import {DATA_ROOT} from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {Agent} from '@earendil-works/pi-agent-core';
import {Store,hash} from './store.mjs';
import {NativeClient,assertExperimentIdle} from './native.mjs';
import {DockerBroker} from './broker.mjs';
import {Skills,skillsPrompt} from './skills.mjs';
import {buildTools,VerdictChannel} from './tools.mjs';
import {taskClock,beginSolve,endSolve,checkpointSolve,stopReserveMs} from './task-clock.mjs';
import {SOLVING_SYSTEM_PROMPT} from './compact-prompts.mjs';
import {presentMessages} from './tool-output.mjs';
import {groups} from './context.mjs';
import {hardLimitContinuation,outputLimitContinuation} from './truncation.mjs';
import {reconcileSubmissionFeedback} from './submission-feedback.mjs';
import {recoverInterruptedTools} from './resume-tools.mjs';

export const SYSTEM=SOLVING_SYSTEM_PROMPT;
export function systemPrompt(mode,knowledge){
 const catalog=mode==='memory-skills'?skillsPrompt(knowledge):'';
 return SYSTEM.replace('{{SKILL_CATALOG}}',catalog);
}

export function validateTask(task) {
  if(Object.keys(task).some(k=>!['id','objective','input_files','source','submission_format'].includes(k)) || !/^[a-zA-Z0-9_-]{1,100}$/.test(task.id) ||
    typeof task.objective!=='string' || !task.objective.trim() || task.objective.length>100000) throw Error('Task must contain only public id/objective/input_files');
  if(task.input_files && (!Array.isArray(task.input_files) || task.input_files.some(x=>typeof x!=='string' || x.length>500))) throw Error('Invalid public input file list');
  for(const [key,limit] of [['source',4000],['submission_format',500]])if(task[key]!==undefined&&(typeof task[key]!=='string'||!task[key].trim()||task[key].length>limit))throw Error('Invalid public task '+key);
}

export async function runTask(task,config,options={}) {
  validateTask(task);
  const root=path.resolve(config.runDir);
  if(root.includes('/benchmarks/')) throw Error('New harness cannot write the active benchmark tree');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const lock=path.join(root,'owner.json');
  if(fs.existsSync(lock)) {
    const prior=JSON.parse(fs.readFileSync(lock,'utf8'));
    if(fs.existsSync(`/proc/${prior.pid}`)) throw Error('Run already owned by a live process');
    if(!options.resume) throw Error('Stale run lease: explicit --resume required after evidence review');
    fs.renameSync(lock,path.join(root,`owner-${Date.now()}.stale.json`));
  }
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,task:task.id}),{flag:'wx',mode:0o600});
  let timer, budgetHeartbeat, solveSegment, cfg, modelLease, store, execution;
  try {
    store=new Store(root);const taskHash=hash(JSON.stringify(task));
    const init=store.events.find(e=>e.type==='task');
    if(init && init.data.sha256!==taskHash) throw Error('Run directory belongs to a different public task');
    if(init && !options.resume) throw Error('Existing task evidence requires --resume');
    if(!init) store.append('task',{task,sha256:taskHash,config});
    if(store.pending().length&&!(options.resume&&config.localRecovery)) throw Error('Uncertain tool outcome: reconcile existing evidence before resuming');
    cfg={runtimeProtocol:'native-read-compact-v3',mode:'memory-skills',nativeImages:false,contextTokens:65536,promptTokens:51200,generationTokens:8192,reasoningTokens:4096,maxTurns:200,
      maxGeneratedTokens:262144,maxSeconds:2400,budgetMode:'active_solve',baseUrl:'http://127.0.0.1:8080',model:'qwen3.8-27b-iq4xs',...config};
    for(const name of ['contextTokens','promptTokens','generationTokens','maxTurns','maxGeneratedTokens','maxSeconds'])
      if(!Number.isInteger(cfg[name]) || cfg[name]<1) throw Error('Invalid numeric configuration: '+name);
    if(!Number.isInteger(cfg.reasoningTokens)||(cfg.reasoningTokens!==-1&&cfg.reasoningTokens<1)||cfg.reasoningTokens>=cfg.generationTokens || cfg.generationTokens+cfg.promptTokens+64>cfg.contextTokens) throw Error('Invalid generation/context reserve');
    for(const key of ['reasoningEffort','compactReasoningEffort'])if(cfg[key]!==undefined&&!['low','medium','high','xhigh'].includes(cfg[key]))throw Error('Invalid '+key);
    if(cfg.compactThinking!==undefined&&typeof cfg.compactThinking!=='boolean')throw Error('Invalid compactThinking');
    if(cfg.compactReasoningTokens!==undefined&&(!Number.isInteger(cfg.compactReasoningTokens)||(cfg.compactReasoningTokens!==-1&&cfg.compactReasoningTokens<1)||cfg.compactReasoningTokens>=(cfg.compactTokens??cfg.generationTokens)))throw Error('Invalid compactReasoningTokens');
    if(!['baseline','memory','memory-skills'].includes(cfg.mode)) throw Error('Unknown evaluation mode');
    const frozen=store.events.findLast(e=>e.type==='configuration');
    if(frozen && frozen.data.sha256!==hash(JSON.stringify(cfg))) throw Error('Run configuration changed; start a separate comparison run');
    if(!frozen) store.append('configuration',{sha256:hash(JSON.stringify(cfg)),config:cfg});
    const priorResult=path.join(root,'result.json');
    if(fs.existsSync(priorResult) && JSON.parse(fs.readFileSync(priorResult,'utf8')).status==='correct') throw Error('Task is already verified correct');
    const clockOptions={startedUnix:options.startedUnix,deadlineUnix:options.deadlineUnix};
    const clock=taskClock(store,cfg,{...clockOptions,start:true});
    if(clock.millisecondsRemaining<=stopReserveMs(cfg))throw Error('Run wall-time budget exhausted');
    const guard=options.guard || assertExperimentIdle;
    guard(); // Before Docker access or any local model metadata request.
    if(!options.testMode) {
      modelLease=cfg.modelLease || path.join(DATA_ROOT,'model-lease.json');
      fs.mkdirSync(path.dirname(modelLease),{recursive:true});
      if(fs.existsSync(modelLease)) {
        const owner=JSON.parse(fs.readFileSync(modelLease,'utf8'));
        if(fs.existsSync(`/proc/${owner.pid}`) || !options.resume) {modelLease=undefined;throw Error('Model lease held or stale; review owner before --resume');}
        fs.renameSync(modelLease,modelLease+'.stale-'+Date.now());
      }
      try {fs.writeFileSync(modelLease,JSON.stringify({pid:process.pid,runDir:root}),{flag:'wx',mode:0o600});}
      catch(error) {modelLease=undefined;throw error;}
    }
    const broker=options.broker || new DockerBroker(cfg.sandbox,store);
    await broker.validate();
    const knowledge=options.knowledge || new Skills(cfg.skillsDir);
    const verdict=options.verdict || new VerdictChannel(task.id,path.join(root,'submissions'),cfg.verdictInbox);
    if(options.resume&&cfg.localRecovery){
      const recovered=recoverInterruptedTools(store,verdict);
      if(store.pending().length)throw Error('Interrupted tool receipt could not be recovered');
      if(recovered.awaitingJudge){const result={status:'awaiting_judge',task_id:task.id,real_model:!options.testMode};store.snapshot('result',result);return result;}
    }
    let status='running',lastSubmission;
    const tools=buildTools(store,broker,knowledge,verdict,result=>{const rank={incorrect:1,pending:2,correct:3};if(!lastSubmission||(rank[result.status]??0)>=(rank[lastSubmission.status]??0))lastSubmission=result;},{nativeImages:cfg.nativeImages,remainingMs:()=>taskClock(store,cfg).millisecondsRemaining}).filter(tool=>
      (cfg.nativeImages || tool.name!=='view_image'));
    // Unknown/interrupted requests consume their full reserved generation budget.
    // A reported usage record replaces that reservation, including length failures.
    const total=(exclude)=>store.events.filter(e=>e.type==='model_request' && e.data.requestId!==exclude).reduce((n,e)=>{
      const usage=store.events.find(u=>u.type==='model_usage' && u.data.requestId===e.data.requestId);
      return n+(usage?.data.completion_tokens ?? e.data.body.max_tokens);
    },0);
    const turns=(exclude)=>store.events.filter(e=>e.type==='model_request' && e.data.requestId!==exclude).length;
    const generationLimit=cfg.generationTokens;
    const client=new NativeClient(cfg,store,{guard:({activeRequestId}={})=>{
      guard();
      if(store.pending().length) throw Error('Uncertain tool outcome');
      if(turns(activeRequestId)>=cfg.maxTurns || total(activeRequestId)>=cfg.maxGeneratedTokens) throw Error('Run budget exhausted');
      cfg.generationTokens=Math.min(generationLimit,cfg.maxGeneratedTokens-total(activeRequestId));
      if(cfg.reasoningTokens!==-1)cfg.reasoningTokens=Math.min(cfg.reasoningTokens,Math.floor(cfg.generationTokens/2));
    },fetchFn:options.fetchFn || fetch,localRecovery:options.localRecovery});
    const model={id:cfg.model,name:cfg.model,api:'openai-completions',provider:'local-qwen',baseUrl:cfg.baseUrl,
      reasoning:true,input:cfg.nativeImages?['text','image']:['text'],contextWindow:cfg.contextTokens,maxTokens:generationLimit,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const saved=presentMessages(store,broker,store.events.filter(e=>e.type==='message').map(e=>e.data))
      .filter(m=>m.role!=='system'&&!(m.role==='assistant' && ['error','aborted'].includes(m.stopReason)));
    // An incomplete generation has no committed assistant/tool messages and can be retried.
    // An assistant with unresolved calls is not silently replayed across a crash.
    if(options.resume && saved.length) {
      const nonSystem=saved.filter(m=>m.role!=='system');
      if(nonSystem.at(-1)?.role==='assistant'){
        const tail=nonSystem.at(-1),continuation=tail.harnessOutputTruncated?outputLimitContinuation(store,tail):hardLimitContinuation(store,tail);
        store.append('message',continuation);saved.push(continuation);
      }
      groups(nonSystem);
    }
    if(options.resume && saved.length) {
      const submissions=reconcileSubmissionFeedback(store,verdict,task.id,saved);
        if(submissions.correct) {
          store.append('task_clock_end',{status:'correct'});
          const result={status:'correct',task_id:task.id,turns:turns(),generated_tokens:total(),real_model:!options.testMode};
          store.snapshot('result',result);return result;
        }
    }
    const previousExecutions=store.events.filter(e=>e.type==='execution_start');
    const processingComplete=previousExecutions.every(e=>store.events.some(x=>x.type==='execution_end'&&x.data.start_seq===e.seq));
    const usedMs=previousExecutions.reduce((sum,e)=>{
      const end=store.events.find(x=>x.type==='execution_end' && x.data.start_seq===e.seq);
      return sum+(end?.data.elapsed_ms ?? Math.max(0,Date.now()-e.time));
    },0);
    if(cfg.budgetMode!=='active_solve'&&usedMs>=cfg.maxSeconds*1000)throw Error('Run wall-time budget exhausted');
    await client.preflight();
    execution=store.append('execution_start',{});
    solveSegment=beginSolve(store,cfg);
    if(solveSegment)budgetHeartbeat=setInterval(()=>checkpointSolve(store,cfg,solveSegment),1000);
    const agent=new Agent({initialState:{systemPrompt:systemPrompt(cfg.mode,knowledge),model,tools,messages:saved,thinkingLevel:cfg.reasoningEffort??'medium'},
      identity:{attribution:null},toolExecution:'sequential',streamFn:client.stream,
      beforeToolCall:()=>store.pending().length?{block:true,terminate:true,reason:'Uncertain earlier tool outcome'}:undefined,
      afterToolCall:()=>store.pending().length?{terminate:true}:undefined,
      finishTurn:async({message})=>{
        if(status==='wall_time_exhausted')return {action:'end'};
        if(message.stopReason==='error' || message.stopReason==='aborted') {status='needs_review';return;}
        if(store.pending().length) {status='needs_review';return {action:'end'};}
        if(lastSubmission && ['correct','pending'].includes(lastSubmission.status)) {status=lastSubmission.status==='correct'?'correct':'awaiting_judge';return {action:'end'};}
        if(turns()>=cfg.maxTurns || total()>=cfg.maxGeneratedTokens) {status='budget_exhausted';return {action:'end'};}
        if(message.harnessTruncated){agent.followUp(hardLimitContinuation(store,message));return {action:'continue'};}
        if(message.harnessOutputTruncated){agent.followUp(outputLimitContinuation(store,message));return {action:'continue'};}
        if(message.stopReason==='stop') {status='model_stopped_without_verified_answer';return {action:'end'};}
      }});
    agent.subscribe(event=>{
      if(event.type==='message_end') store.append('message',event.message);
      if(event.type==='turn_end') store.snapshot('state',{status,pid:process.pid,turns:turns(),generated_tokens:total(),task_id:task.id,lastSubmission});
    });
    const remainingMs=Math.max(0,taskClock(store,cfg,clockOptions).millisecondsRemaining-stopReserveMs(cfg));
    if(remainingMs<=0)throw Error('Run wall-time budget exhausted');
    timer=setTimeout(()=>{status='wall_time_exhausted';agent.abort();},remainingMs);
    if(options.resume && saved.length) {
      await agent.continue();
    } else await agent.prompt(JSON.stringify(task));
    endSolve(store,cfg,solveSegment,status);
    if(['correct','wall_time_exhausted','budget_exhausted','model_stopped_without_verified_answer'].includes(status))store.append('task_clock_end',{status});
    const timing=taskClock(store,cfg,clockOptions),processingMs=usedMs+Date.now()-execution.time,solveMs=cfg.budgetMode==='active_solve'?timing.elapsedSolveMs:processingMs;
    const result={status,task_id:task.id,turns:turns(),generated_tokens:total(),pending_tools:store.pending().length,
      error:agent.state.errorMessage || null,real_model:!options.testMode,active_wall_ms:solveMs,processing_wall_ms:cfg.budgetMode==='active_solve'&&!processingComplete?null:processingMs,processing_wall_complete:processingComplete,stop_reserve_ms:stopReserveMs(cfg),wall_elapsed_ms:timing.elapsedWallMs,solve_elapsed_ms:timing.elapsedSolveMs,budget_scope:timing.budgetScope,deadline_unix:timing.deadlineUnix,compaction_ms:timing.compactionMs,maintenance_wall_ms:Math.max(0,timing.elapsedWallMs-solveMs)};
    store.snapshot('result',result);return result;
  } finally {
    clearTimeout(timer);clearInterval(budgetHeartbeat);if(store&&cfg)endSolve(store,cfg,solveSegment);
    try {if(execution)store.append('execution_end',{start_seq:execution.seq,elapsed_ms:Math.max(0,Date.now()-execution.time)});}
    finally {if(modelLease)fs.unlinkSync(modelLease);fs.unlinkSync(lock);}
  }
}
