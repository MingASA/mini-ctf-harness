import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {hash} from './store.mjs';
import {generationSettings,bodySettings,settingsHash} from './generation-controls.mjs';
import {assertExperimentIdle} from './native.mjs';
import {admitRamKv,availableRamMiB,estimateRamKv,worthSaving} from './ram-kv.mjs';
export class KvCache {
 constructor(config,{fetchFn=fetch,guard=assertExperimentIdle,ram,measureRam=availableRamMiB}={}){this.config=config;this.fetch=fetchFn;this.guard=guard;this.ram=ram;this.measureRam=measureRam;}
 identity(){return hash(JSON.stringify({model:this.config.model,context:this.config.contextTokens,identity:this.ram?.identity??this.config.kv?.identity}));}
 checkpointName(){return this.ram?'ram-kv-checkpoint':'kv-checkpoint';}
 async call(route,body){
  this.guard();const url=new URL(this.config.baseUrl);
  if(!['127.0.0.1','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw Error('KV backend must be local');
  const response=await this.fetch(url.origin+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Object.assign(Error(`KV backend HTTP ${response.status}; --slot-save-path may be unavailable`),{requestFinished:true});
  return response.json();
 }
 async idle(){
  for(let attempt=0;;attempt++){
   const slots=await this.call('/slots');
   if(Array.isArray(slots)&&slots.every(slot=>slot.is_processing===false))return slots;
   if(!this.ram||attempt===20)throw Error('KV operation requires an idle inference slot');
   await delay(150);
  }
 }
 admit(phase,bytes){
  admitRamKv({...this.ram,availableMiB:this.measureRam(this.ram.readWindows),
   vision:this.ram.cpuProjector??this.config.nativeImages,phase,bytes});
 }
 ramFile(filename){
  if(!/^ctf-[a-zA-Z0-9_-]+-[a-f0-9]{16}\.bin$/.test(filename))throw Error('Invalid RAM KV filename');
  return path.join(this.ram.directory,filename);
 }
 discardRamSnapshot(taskId,filename){
  if(typeof filename!=='string'||!filename.startsWith(`ctf-${taskId}-`))return;
  try{fs.unlinkSync(this.ramFile(filename));}catch{}
 }
 async save(session){
  const conversation=session.messages(),fingerprint=hash(JSON.stringify(conversation));
  session.store.snapshot('conversation-checkpoint',{taskId:session.task.id,fingerprint,messages:conversation,time:Date.now()});
  const base={taskId:session.task.id,conversationSaved:true,conversationSha256:fingerprint,modelEpoch:session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??null,compactSeq:session.store.events.findLast(e=>e.type==='compact_commit')?.seq??null,identity:this.identity(),time:Date.now()};
  if(!this.ram&&(!this.config.kv?.enabled||!this.config.kv.identity))return {...base,status:'unavailable',reason:'KV requires enabled:true, a pinned identity, and server --slot-save-path'};
  const last=session.store.events.findLast(e=>e.type==='model_request');
  const terminal=last&&session.store.events.findLast(e=>['model_response','model_interrupted'].includes(e.type)&&e.data.requestId===last.data.requestId);
  if(!terminal)return {...base,status:'unavailable',reason:'The latest generation is incomplete; only conversation is saved'};
  if(this.ram&&terminal.type==='model_interrupted'&&!terminal.data.decoded)
   return {...base,status:'unavailable',reason:'The request was interrupted before generation established slot ownership'};
  if(last.seq<(session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??-1))return {...base,status:'unavailable',reason:'Model switched after the last generation'};
  let ramFile,stageFile,receiptArrived=false,committed=false;
  try {
   const slots=await this.idle();
   const filename=`ctf-${session.task.id}-${this.ram?randomBytes(8).toString('hex'):fingerprint.slice(0,16)}.bin`,slot=this.ram?0:this.config.kv.slot??0;
   let estimatedBytes;
   if(this.ram){
    const main=slots.find(s=>s.id===slot);
    if(!main||main.n_ctx!==this.config.contextTokens)throw Error('RAM KV requires the managed main slot');
    if(slots.length!==1){
     const capability=(await this.call('/kv-cache')).ctf_btw;
     if(slots.length!==2||slot!==0||!capability?.enabled||!capability.kv_unified||capability.main_slot!==0||capability.branch_slot!==1)throw Error('RAM KV requires the managed single-slot or protected two-slot backend');
    }
    const tokens=main.n_prompt_tokens;
    if(!Number.isInteger(tokens)||!Number.isInteger(last.data.prompt_tokens)||tokens<last.data.prompt_tokens||tokens>this.config.contextTokens||tokens<=0)
     throw Error('No complete resident prefix is available');
    const media=last.data.body?.messages?.flatMap(m=>Array.isArray(m.content)?m.content.filter(part=>part.type!=='text'):[])??[];
    if(media.length&&(!this.ram.vision||media.some(part=>part.type!=='image_url')))
     throw Error('RAM KV supports images with the same managed projector profile');
    // llama.cpp persists visual token positions and placeholder metadata. Pixel data stays in the transcript.
    const visualMetadataBytes=media.length?1024**2:0;
    estimatedBytes=estimateRamKv(this.ram,tokens)+visualMetadataBytes;
    const transferBytes=estimateRamKv({...this.ram,stateMiB:this.ram.measuredStateMiB??this.ram.stateMiB},tokens)+visualMetadataBytes;
    const imageSeconds=media.length&&this.ram.cpuProjector?this.ram.cpuImageSeconds??0:0;
    if(!worthSaving({...this.ram,tokens,sharedTokens:1024,bytes:transferBytes,imageSeconds}))
     return {...base,status:'skipped',reason:'Estimated round trip is too close to prefix recomputation'};
    this.admit('save',estimatedBytes);
    ramFile=this.ramFile(filename);
    stageFile=this.ram.stage?path.join(this.ram.stage,filename):null;
   }
   const started=performance.now();
   const receipt=await this.call(`/slots/${slot}?action=save`,{filename});
   receiptArrived=true;
   if(receipt.id_slot!==slot||receipt.filename!==filename||!(receipt.n_saved>0)||!(receipt.n_written>0))throw Error('KV save receipt did not verify nonempty data');
   if(this.ram){
    const stat=fs.lstatSync(stageFile??ramFile);
    if(!stat.isFile()||receipt.n_saved!==slots.find(s=>s.id===slot).n_prompt_tokens||receipt.n_written!==stat.size||receipt.n_written>estimatedBytes)
     throw Error('RAM snapshot differs from the admitted slot size');
    if(stageFile){
     this.admit('save',stat.size);
     await fs.promises.copyFile(stageFile,ramFile,fs.constants.COPYFILE_EXCL);
     if(fs.statSync(ramFile).size!==stat.size)throw Error('Incomplete RAM snapshot copy');
    }
   }
   const result={...base,status:'saved',filename,slot,receipt,transferMs:performance.now()-started,
    lastRequestId:last.data.requestId,generationSettings:bodySettings(last.data.body)};
   const checkpoint=path.join(session.store.root,this.checkpointName()+'.json');
   const previous=this.ram&&fs.existsSync(checkpoint)?JSON.parse(fs.readFileSync(checkpoint,'utf8')):null;
   session.store.snapshot(this.checkpointName(),result);
   committed=true;
   if(previous?.taskId===session.task.id&&previous.filename!==filename)this.discardRamSnapshot(session.task.id,previous.filename);
   session.store.append('kv_saved',result);return result;
  }catch(e){
   if(ramFile&&!committed&&(stageFile||receiptArrived||e.requestFinished)){try{fs.unlinkSync(ramFile);}catch{}}
   receiptArrived=receiptArrived||e.requestFinished;
   const result={...base,status:'unavailable',reason:e.message};session.store.append('kv_save_failed',result);return result;
  }finally{if(stageFile&&receiptArrived){try{fs.unlinkSync(stageFile);}catch{}}}
 }
 async restore(session){
  if(!this.ram&&!this.config.kv?.enabled)return {status:'not_saved'};
  const file=path.join(session.store.root,this.checkpointName()+'.json');
  if(!fs.existsSync(file))return {status:'not_saved'};
  let stageFile,finished=false,posted=false;
  try {
   const started=performance.now();
   const saved=JSON.parse(fs.readFileSync(file,'utf8'));
   const stale=reason=>{
    if(this.ram&&saved.taskId===session.task.id)this.discardRamSnapshot(saved.taskId,saved.filename);
    return {status:'stale',reason};
   };
   if(saved.taskId!==session.task.id||saved.identity!==this.identity())return stale('KV model/runtime identity changed');
   if((saved.modelEpoch??null)!==(session.store.events.findLast(e=>e.type==='kv_invalidated')?.seq??null))return stale('KV invalidated by model switching');
   if(saved.compactSeq!==(session.store.events.findLast(e=>e.type==='compact_commit')?.seq??null))return stale('Compact checkpoint changed after KV save');
   if(settingsHash(saved.generationSettings)!==settingsHash(generationSettings(session.config??this.config)))return stale('Generation settings changed; native prefix will be revalidated');
   if(!/^ctf-[a-zA-Z0-9_-]+-[a-f0-9]{16}\.bin$/.test(saved.filename))throw Error('Invalid KV filename');
   if(saved.conversationSha256!==hash(JSON.stringify(session.messages())))return stale('Conversation changed after KV save; replay full conversation');
   if(this.ram){
    if(saved.slot!==0||!saved.filename.startsWith(`ctf-${session.task.id}-`))throw Error('RAM snapshot does not belong to this task and slot');
    const checkpoint=fs.lstatSync(this.ramFile(saved.filename),{throwIfNoEntry:false});
    if(!checkpoint?.isFile()||checkpoint.size!==saved.receipt.n_written)return stale('RAM snapshot missing or size changed');
    this.admit('restore',checkpoint.size);
    if(this.ram.stage){
     stageFile=path.join(this.ram.stage,saved.filename);
     await fs.promises.copyFile(this.ramFile(saved.filename),stageFile,fs.constants.COPYFILE_EXCL);
    }
   }
   await this.idle();
   posted=true;
   const result=await this.call(`/slots/${saved.slot}?action=restore`,{filename:saved.filename});finished=true;
   if(result.id_slot!==saved.slot||result.filename!==saved.filename||result.n_restored!==saved.receipt.n_saved||!(result.n_read>0)||(this.ram&&result.n_read!==saved.receipt.n_written))throw Error('KV restore receipt mismatch');
   session.store.append('kv_restored',{filename:saved.filename,result,transferMs:performance.now()-started});
   if(this.ram)this.discardRamSnapshot(saved.taskId,saved.filename);
   return {status:'restored',result};
  }catch(error){
   finished=finished||error.requestFinished;
   session.store.append('kv_restore_failed',{error:error.message});return {status:'unavailable',reason:error.message};
  }finally{if(stageFile&&(finished||!posted)){try{fs.unlinkSync(stageFile);}catch{}}}
 }
}
