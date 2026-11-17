import {hash} from './store.mjs';

// A provider continuation must not end on a completed assistant prefix. This
// observation is queued/persisted like any other message, never a human request.
export function hardLimitContinuation(store,message){
 if(message?.role!=='assistant'||message.stopReason!=='stop'||message.harnessTruncated!==true||message.content?.some(x=>x.type==='toolCall'))throw Error('Assistant tail requires explicit review; tool execution is not replayed');
 if(store.pending().length)throw Error('Uncertain tool outcome blocks continuation');
 const event=store.events.findLast(e=>e.type==='message'&&hash(JSON.stringify(e.data))===hash(JSON.stringify(message)));
 const cause=event&&store.events[event.seq-1];
 if(cause?.type!=='model_truncated'||!['hard_context_limit','compact_capacity_limit'].includes(cause.data.reason))throw Error('Missing native hard-limit truncation proof');
 return {role:'user',harnessInboxKind:'observation',harnessTruncationContinuationFor:event.seq,timestamp:Date.now(),
  content:'Harness observation: the previous generation reached its context capacity allowance; it was not a task conclusion. Continue from the recovery view and retained evidence. Any incomplete tool calls were not executed. Do not replay already completed tools.'};
}

// An output limit is separate from context pressure: do not force Compact merely
// because a normal generation used its output allowance. The context manager's
// exact admission and configured soft trigger still apply to the next request.
export function outputLimitContinuation(store,message){
 if(message?.role!=='assistant'||message.stopReason!=='stop'||message.harnessOutputTruncated!==true||!message.content?.length||message.content.some(x=>!['thinking','text'].includes(x.type)))throw Error('Output continuation requires a tool-free retained assistant');
 if(store.pending().length)throw Error('Uncertain tool outcome blocks continuation');
 const event=store.events.findLast(e=>e.type==='message'&&hash(JSON.stringify(e.data))===hash(JSON.stringify(message)));
 const cause=event&&store.events[event.seq-1];
 if(cause?.type!=='model_output_truncated'||cause.data.reason!=='generation_output_limit'||cause.data.content_sha256!==hash(JSON.stringify(message.content)))throw Error('Missing native output-limit truncation proof');
 return {role:'user',harnessInboxKind:'observation',harnessOutputContinuationFor:event.seq,timestamp:Date.now(),
  content:'Harness observation: the previous response reached its per-call output limit. Its retained thinking/text is incomplete, not a task conclusion. Continue from the retained reasoning and evidence without restarting the same analysis; finish the current reasoning and take the next evidence-backed action. No tool calls were executed from that response. Do not replay already completed tools.'};
}
