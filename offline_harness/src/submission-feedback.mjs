import {hash} from './store.mjs';

const legacyFeedback='Trusted judge feedback: that submitted candidate is incorrect. Revise using task evidence.';
// Resolve retained requests, never replay tool executions. Each feedback message
// carries its own call identity so a crash between events is recoverable.
export function reconcileSubmissionFeedback(store,verdict,taskId,saved){
 const calls=store.events.filter(e=>e.type==='tool_start'&&e.data.name==='submit_flag');
 const ids=new Map(calls.map(e=>[hash(taskId+'\0'+e.data.callId),e.data.callId]));
 const delivered=new Set();
 for(const e of store.events.filter(e=>e.type==='message')){
  const m=e.data;if(m.harnessSubmissionCallId)delivered.add(m.harnessSubmissionCallId);
  if(m.harnessInboxKind==='observation'&&m.content===legacyFeedback){
   const prior=store.events.findLast(x=>x.seq<e.seq&&x.type==='submission'&&x.data.status==='incorrect');
   const call=prior&&(prior.data.call_id||ids.get(prior.data.submission_id));if(call)delivered.add(call);
  }
 }
 const plan=[];
 for(const e of calls){
  const {callId,args}=e.data,id=hash(taskId+'\0'+callId);
  const prior=store.events.findLast(x=>x.type==='submission'&&(x.data.submission_id===id||x.data.call_id===callId));
  if(!prior)continue;
  let result=prior.data;
  if(result.status==='pending')result=typeof verdict.resolve==='function'?verdict.resolve(callId,args.candidate):verdict.submit(callId,args.candidate);
  if(result.status==='pending')throw Error('Still awaiting external judge');
  if(!['correct','incorrect'].includes(result.status))throw Error('Invalid retained verdict status');
  plan.push({callId,id,prior,result:{...result,submission_id:id,call_id:callId}});
 }
 for(const {callId,id,prior,result} of plan){
  if(prior.data.status!==result.status)store.append('submission',result);
  if(delivered.has(callId))continue;
  const feedback={role:'user',harnessInboxKind:'observation',harnessSubmissionCallId:callId,harnessSubmissionId:id,
   content:'Trusted judge feedback: '+JSON.stringify({candidate:calls.find(e=>e.data.callId===callId)?.data.args.candidate,status:result.status})+'. Revise using task evidence if incorrect.',timestamp:Date.now()};
  store.append('message',feedback);saved.push(feedback);delivered.add(callId);
 }
 return {resolved:plan.length,correct:plan.some(p=>p.result.status==='correct')};
}
