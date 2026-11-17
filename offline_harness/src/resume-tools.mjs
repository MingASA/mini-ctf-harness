import {submissionOutput} from './tool-output.mjs';
// Close gaps left by a dead runner using durable observations, never by running
// an old tool again. Unknown execution remains explicitly unknown to the model.
export function recoverInterruptedTools(store,verdict){
 const calls=store.events.filter(e=>e.type==='message'&&e.data.role==='assistant')
  .flatMap(e=>(e.data.content||[]).filter(c=>c.type==='toolCall'));
 let recovered=0,awaitingJudge=false;
 for(const call of calls){
  const answered=store.events.some(e=>e.type==='message'&&e.data.role==='toolResult'&&e.data.toolCallId===call.id);
  let done=store.events.find(e=>e.type==='tool_done'&&e.data.callId===call.id);
  const started=store.events.find(e=>e.type==='tool_start'&&e.data.callId===call.id);
  if(answered&&(!started||done))continue;
  if(!done){
   const job=store.events.find(e=>['job_started','job_launch_attempt','job_allocated'].includes(e.type)&&e.data.callId===call.id)?.data;
   let observation={error:started?'The runner exited before the tool result was committed. Execution outcome is unknown.':'The runner exited before this tool was started. No execution was recorded.',operation_completed:false,execution_status:started?'unknown_after_runner_exit':'not_started',...(job?{job_id:job.job_id,note:'Observe the existing job; it has not been relaunched.'}:{})};
   if(started&&call.name==='submit_flag'&&typeof verdict?.resolve==='function'){
    try{
     const result=verdict.resolve(call.id,call.arguments.candidate);
     if(['correct','incorrect','pending','awaiting_review'].includes(result.status)){
      observation=result;store.append('submission',{...result,call_id:call.id});
      if(result.status==='pending')awaitingJudge=true;
     }
    }catch{}
   }
   const ref=store.put(observation,'recovery:tool_outcome');
   const result={content:[{type:'text',text:JSON.stringify(call.name==='submit_flag'?submissionOutput(observation):observation)}],details:{evidence_id:ref.id,recovered_after_runner_exit:true,...(job?{job_id:job.job_id}:{})},isError:!['correct','incorrect','pending','awaiting_review'].includes(observation.status)};
   if(started)done=store.append('tool_done',{callId:call.id,result});
   else done={data:{result}};
  }
  if(!answered){
   const result=done.data.result;
   store.append('message',{role:'toolResult',toolCallId:call.id,toolName:call.name,content:result.content,details:result.details||{},isError:result.isError===true,timestamp:Date.now(),harnessRecoveredToolResult:true});
  }
  store.append('tool_result_recovered',{callId:call.id,source:done.seq===undefined?'not_started':done.seq,executed_again:false});recovered++;
 }
 return {recovered,awaitingJudge};
}
