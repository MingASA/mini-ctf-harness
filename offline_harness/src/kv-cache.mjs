import fs from 'node:fs';
import path from 'node:path';
import {hash,atomic} from './store.mjs';
import {generationSettings,bodySettings,settingsHash} from './generation-controls.mjs';
import {assertExperimentIdle} from './native.mjs';
export class KvCache {
 constructor(config,{fetchFn=fetch,guard=assertExperimentIdle}={}){this.config=config;this.fetch=fetchFn;this.guard=guard;}
 identity(){return hash(JSON.stringify({model:this.config.model,context:this.config.contextTokens,identity:this.config.kv?.identity}));}
 async call(route,body){
  this.guard();const url=new URL(this.config.baseUrl);
  if(!['127.0.0.1','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw Error('KV backend must be local');
  const response=await this.fetch(url.origin+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Error(`KV backend HTTP ${response.status}; --slot-save-path may be unavailable`);
  return response.json();
 }
 async idle(){const slots=await this.call('/slots');if(!Array.isArray(slots)||slots.some(s=>s.is_processing))throw Error('KV operation requires an idle inference slot');}
 async save(session){
  const conversation=session.messages(),fingerprint=hash(JSON.stringify(conversation));
  session.store.snapshot('conversation-checkpoint',{taskId:session.task.id,fingerprint,messages:conversation,time:Date.now()});
  const base={taskId:session.task.id,conversationSaved:true,conversationSha256:fingerprint,modelEpoch:session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??null,compactSeq:session.store.events.findLast(e=>e.type==='compact_commit')?.seq??null,identity:this.identity(),time:Date.now()};
  if(!this.config.kv?.enabled||!this.config.kv.identity)return {...base,status:'unavailable',reason:'KV requires enabled:true, a pinned identity, and server --slot-save-path'};
  const last=session.store.events.filter(e=>e.type==='model_request').at(-1);
  if(!last||!session.store.events.some(e=>['model_response','model_interrupted'].includes(e.type)&&e.data.requestId===last.data.requestId))return {...base,status:'unavailable',reason:'The latest generation is incomplete; only conversation is saved'};
  if(last.seq<(session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??-1))return {...base,status:'unavailable',reason:'Model switched after the last generation'};
  try {
   await this.idle();
   const filename=`ctf-${session.task.id}-${fingerprint.slice(0,16)}.bin`,slot=this.config.kv.slot??0;
   const receipt=await this.call(`/slots/${slot}?action=save`,{filename});
   if(receipt.id_slot!==slot||receipt.filename!==filename||!(receipt.n_saved>0)||!(receipt.n_written>0))throw Error('KV save receipt did not verify nonempty data');
   const result={...base,status:'saved',filename,slot,receipt,lastRequestId:last.data.requestId,generationSettings:bodySettings(last.data.body)};
   session.store.snapshot('kv-checkpoint',result);session.store.append('kv_saved',result);return result;
  }catch(e){const result={...base,status:'unavailable',reason:e.message};session.store.append('kv_save_failed',result);return result;}
 }
 async restore(session){
  if(!this.config.kv?.enabled)return {status:'not_saved'};
  const file=path.join(session.store.root,'kv-checkpoint.json');
  if(!fs.existsSync(file))return {status:'not_saved'};
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(saved.taskId!==session.task.id||saved.identity!==this.identity())return {status:'stale',reason:'KV model/runtime identity changed'};
  if((saved.modelEpoch??null)!==(session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??null))return {status:'stale',reason:'KV invalidated by model switching'};
  if(saved.compactSeq!==(session.store.events.findLast(e=>e.type==='compact_commit')?.seq??null))return {status:'stale',reason:'Compact checkpoint changed after KV save'};
  if(settingsHash(saved.generationSettings)!==settingsHash(generationSettings(session.config??this.config)))return {status:'stale',reason:'Generation settings changed; native prefix will be revalidated'};
  if(!/^ctf-[a-zA-Z0-9_-]+-[a-f0-9]{16}\.bin$/.test(saved.filename))throw Error('Invalid KV filename');
  if(saved.conversationSha256!==hash(JSON.stringify(session.messages())))return {status:'stale',reason:'Conversation changed after KV save; replay full conversation'};
  try {
   await this.idle();const result=await this.call(`/slots/${saved.slot}?action=restore`,{filename:saved.filename});
   if(result.id_slot!==saved.slot||result.filename!==saved.filename||result.n_restored!==saved.receipt.n_saved||!(result.n_read>0))throw Error('KV restore receipt mismatch');
   session.store.append('kv_restored',{filename:saved.filename,result});return {status:'restored',result};
  }catch(error){session.store.append('kv_restore_failed',{error:error.message});return {status:'unavailable',reason:error.message};}
 }
}
