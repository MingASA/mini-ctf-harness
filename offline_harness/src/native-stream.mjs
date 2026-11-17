// Keep cancellation attached to the reader as well as the HTTP request.
export async function* streamChunks(body,signal){
 const reader=body.getReader();
 const abort=()=>{reader.cancel(signal.reason).catch(()=>{});};
 signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();
  for(;;){const {done,value}=await reader.read();signal?.throwIfAborted();if(done)return;yield value;}
 }finally{
  signal?.removeEventListener('abort',abort);
  await reader.cancel().catch(()=>{});reader.releaseLock();
 }
}
