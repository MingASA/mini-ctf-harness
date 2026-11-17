export function toolError(store,name,callId,error){
 store.append('tool_error',{name,callId,error:{name:error.name,code:error.code,message:error.message,stderr:error.stderr}});
 if(error.cmd||error.spawnargs){
  if(error.code==='ENOENT')return 'The task tool runner is unavailable.';
  if(error.killed||error.code==='ETIMEDOUT'||error.signal)return 'The tool connection timed out. An existing job may still be running.';
  const last=String(error.stderr??'').trim().split('\n').at(-1);
  const detail=last&&/^[A-Za-z]+(?:Error|Exception):/.test(last)?last.replace(/\/work\/\.offline-jobs\/[a-f0-9]+(?:\/[\w.-]+)?/g,'job record').slice(0,400):'';
  return 'The task tool connection failed.'+(detail?' '+detail:'');
 }
 return String(error.message??error).slice(0,1000);
}
