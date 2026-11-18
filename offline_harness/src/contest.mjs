import {DATA_ROOT} from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomic,hash} from './store.mjs';
import {sourceIdentity} from './source-identity.mjs';
import {TaskNumbers} from './task-numbers.mjs';
import {ContestQueue} from './contest-queue.mjs';
import {InteractiveSession} from './interactive-session.mjs';
import {ModelCatalog} from './model-catalog.mjs';
import {SESSION_DEFAULTS} from './interactive-session.mjs';
import {KvCache} from './kv-cache.mjs';
import {RAM_KV_LIMIT_DEFAULTS,ramKvLimits} from './ram-kv.mjs';
import {RagClient} from './rag/client.mjs';
import {VisionClient} from './vision-client.mjs';
import {assertExperimentIdle} from './native.mjs';
import {validateServiceUrl} from './service-endpoint.mjs';
const exec=promisify(execFile);
const live=pid=>Number.isInteger(pid)&&fs.existsSync(`/proc/${pid}/stat`)&&fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1)[0]!=='Z';

export function copyAttachments(source,destination,{maxBytes=200*1024*1024,maxFiles=5000}={}){
 const files=[];let bytes=0;
 if(!source)return files;
 const root=fs.realpathSync(source);if(!fs.statSync(root).isDirectory())throw Error('Attachment source must be a directory');
 const visit=(dir,rel='')=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
  if(ent.name==='.offline-jobs'||ent.isSymbolicLink())throw Error('Attachment symlinks and reserved job directories are not supported');
  const name=path.join(rel,ent.name),src=path.join(dir,ent.name),st=fs.lstatSync(src);
  if(ent.isDirectory())visit(src,name);
  else if(ent.isFile()){
   if((bytes+=st.size)>maxBytes||files.length>=maxFiles)throw Error('Attachment import limit exceeded');
   files.push({name,src,sha256:hash(fs.readFileSync(src)),bytes:st.size});
  }else throw Error('Attachment directory contains a special file');
 }};
 visit(root);
 for(const file of files){const dest=path.join(destination,'attachments',file.name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file.src,dest,fs.constants.COPYFILE_EXCL);if(hash(fs.readFileSync(dest))!==file.sha256)throw Error('Attachment changed during import');}
 return files.map(({src,...file})=>({...file,path:'/work/attachments/'+file.name}));
}
export class Contest extends EventEmitter {
 constructor(config,options={}){
  super();this.config={...config};this.options=options;this.root=path.resolve(config.contestDir);if(this.root.includes('/benchmarks/'))throw Error('Competition state needs a separate development directory');
  fs.mkdirSync(this.root,{recursive:true,mode:0o700});this.lock=path.join(this.root,'owner.json');
  if(fs.existsSync(this.lock)){
   const prior=JSON.parse(fs.readFileSync(this.lock));if(live(prior.pid))throw Error('Competition terminal already open');
   fs.renameSync(this.lock,this.lock+'.stale-'+Date.now());
  }
  fs.writeFileSync(this.lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
  this.source=sourceIdentity();
  fs.mkdirSync(path.join(this.root,'startups'),{recursive:true});atomic(path.join(this.root,'startups',Date.now()+'-'+process.pid+'.json'),this.source);
  this.sessions=new Map();this.records=new Map();this.enabled=false;this.closing=false;this.busy=false;this.polling=false;this.notice='';this.active=null;this.manualNext=null;this.checkpointRequested=false;this.maintenance=new Map();this.holdResident=false;this.resident=null;this.interruptEpoch=0;
  this.guard=options.guard||assertExperimentIdle;this.queue=new ContestQueue(this.root);
  this.defaultModel={...SESSION_DEFAULTS,...config.model};this.catalog=options.modelCatalog??new ModelCatalog(this.config,{guard:this.guard,fetchFn:options.modelFetch??fetch,executeFn:options.modelExecute});
  const selection=path.join(this.root,'model-selection.json');if(fs.existsSync(selection))Object.assign(this.defaultModel,JSON.parse(fs.readFileSync(selection)).settings);
  try {
   this.ramKvBasePolicy=config.modelRuntime?.ramKv;
   this.ramKvSettingsFile=path.join(this.root,'ram-kv-limits.json');
   this.ramKvOverrides=fs.existsSync(this.ramKvSettingsFile)
    ?ramKvLimits(JSON.parse(fs.readFileSync(this.ramKvSettingsFile,'utf8')),{defaults:false}):{};
   this.applyRamKvSettings(this.ramKvOverrides);
   const file=path.join(this.root,'tasks.json');
   const records=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];this.numbers=new TaskNumbers(this.root,records.map(r=>r.task.id));
   for(const record of records){this.records.set(record.task.id,record);this.load(record);}
   if(this.queue.state.running){const id=this.queue.state.running.taskId,s=this.session(id);this.queue.settle(id,s.store.pending().length?'needs_review':'paused');s.store.append('restart_recovery',{note:'Prior inference stopped. Commands were not replayed.'});this.retryLocally(id);}
   for(const [id,s] of this.sessions){
    if(!this.queue.item(id))this.queue.enqueue(id,'fresh');
    const state=this.status(id),queued=s.inbox.items().some(x=>x.status==='queued');
    if(queued&&(['awaiting_input','awaiting_judge','awaiting_review'].includes(state)||(['waiting_tool','waiting_service'].includes(state)&&!s.dependencies().length)))this.queue.enqueue(id,'resume',{reason:'recovered_inbox'});
    s.status=this.status(id);
   }
  }catch(e){fs.unlinkSync(this.lock);throw e;}
 }
 load(record){
  const remote={};if(this.config.services?.rag)remote.rag=new RagClient(this.config.services.rag);if(this.config.services?.vision)remote.vision=new VisionClient(this.config.services.vision);
  const opts={guard:this.guard,remote,...this.options.sessionOptions?.(record)};
  const session=this.options.sessionFactory?.(record,opts)||new InteractiveSession(record.task,record.config,opts);
  session.on('auxiliary',event=>this.emit('auxiliary',{taskId:record.task.id,event}));
  session.on('change',()=>this.emit('change'));session.on('agent',event=>this.emit('agent',{taskId:record.task.id,event}));session.on('journal',event=>this.emit('journal',{taskId:record.task.id,event}));
  this.sessions.set(record.task.id,session);return session;
 }
 save(){atomic(path.join(this.root,'tasks.json'),[...this.records.values()]);}
 taskLabel(id){return this.numbers.label(id);}
 taskTitle(id){const r=this.records.get(id);return r?.title===id?'题目 '+this.taskLabel(id):r?.title;}
 resolveTaskId(id){return this.numbers.resolve(id,this.records);}
 session(id){id=this.resolveTaskId(id);const s=this.sessions.get(id);if(!s)throw Error('Unknown task '+id);return s;}
 queueRows(){return [...this.records.values()].map(r=>{const s=this.session(r.task.id);return {id:r.task.id,title:this.taskTitle(r.task.id),status:this.status(r.task.id),model:s.config.model,jobs:s.dependencies().length,reviews:s.candidates().filter(x=>!x.feedback||x.feedback.status==='pending')};});}
 status(id){id=this.resolveTaskId(id);const item=this.queue.item(id);if(this.active===id)return 'running';if(this.queue.state.readyResume.some(x=>x.taskId===id))return 'ready_resume';if(this.queue.state.readyFresh.some(x=>x.taskId===id))return 'ready_fresh';return item?.status||'idle';}
 async add({id,title,objective,attachmentDir='',target='',sandbox}){
  id=id??this.numbers.allocate();
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||this.records.has(id))throw Error('Task ID invalid or already exists');
  if(typeof objective!=='string'||!objective.trim()||objective.length>90000)throw Error('Paste a task statement of 1..90000 characters');
  if(target)validateServiceUrl(target);
  const runDir=path.join(this.root,'tasks',id);fs.mkdirSync(runDir,{recursive:true});
  let work;
  sandbox=sandbox||this.config.sandboxes?.find(s=>![...this.records.values()].some(r=>r.config.sandbox?.containerId===s.containerId||r.config.sandbox?.workDir===s.workDir));
  if(sandbox){work=sandbox.workDir;if([...this.records.values()].some(r=>r.config.sandbox?.containerId===sandbox.containerId||r.config.sandbox?.workDir===work))throw Error('Each task needs its own sandbox');}
  else if(this.options.provision){sandbox=await this.options.provision(id,{target,environment:this.environmentName});work=sandbox.workDir;}
  else {
   const p=this.config.provision;if(!p)throw Error('Configure provision or supply an unused sandbox receipt');
   const base=path.resolve(p.workBase);if(!base.includes('/offline-harness/work')||base.includes('/benchmarks/'))throw Error('Invalid competition work base');
   work=path.join(base,id);fs.mkdirSync(work,{recursive:true});if(fs.readdirSync(work).length)throw Error('New task work directory is not empty');
   // Import before starting the new solver. No target services are deployed.
   const attachments=copyAttachments(attachmentDir,work,this.config.importLimits);
   const out=path.join(runDir,'sandbox.json');
   await exec('python3',[new URL('../scripts/provision_sandbox.py',import.meta.url).pathname,'--docker',p.docker||'docker','--host',p.dockerHost||'unix:///var/run/docker.sock','--image',p.image,'--work-base',base,'--work-dir',work,'--out',out],{timeout:60000,maxBuffer:1024*1024});
   sandbox=JSON.parse(fs.readFileSync(out));return this.register({id,title,objective,target,attachmentDir,attachments,sandbox,runDir});
  }
  const attachments=copyAttachments(attachmentDir,work,this.config.importLimits);
  return this.register({id,title,objective,target,attachmentDir,attachments,sandbox,runDir});
 }
 register({id,title,objective,target,attachmentDir,attachments,sandbox,runDir}){
  const task={id,objective:objective+(target?'\nOperator-supplied target address: '+target:''),input_files:attachments.map(x=>x.path)};
  const record={task,title:String(title||id).slice(0,200),target,attachmentDir,attachments,config:{...this.defaultModel,...this.pendingDefaultModel,runDir,sandbox}};
  this.numbers.assign(id);this.records.set(id,record);this.save();const s=this.load(record);s.store.append('attachment_manifest',{files:attachments});this.queue.enqueue(id,'fresh');this.emit('change');return record;
 }
 enqueue(id,text){id=this.resolveTaskId(id);const s=this.session(id);const result=s.enqueue(text);const status=this.status(id);if(['awaiting_input','awaiting_judge','awaiting_review','idle','paused'].includes(status))this.queue.enqueue(id,'resume');if(this.holdResident&&!this.enabled){this.manualNext=id;this.start();}this.emit('change');return result;}
 interruptActive(){
  this.modelSwitchController?.abort();this.interruptEpoch++;this.enabled=false;this.holdResident=true;this.manualNext=null;
  const id=this.active??this.resident;
  if(id){const s=this.session(id);s.store.append('operator_interrupt',{taskId:id,model_unloaded:false,kv_erased:false});s.pause();if(this.active!==id)this.queue.settle(id,'paused',s.dependencies());}
  this.notice='已停止生成与调度，保留输出及驻留模型；输入消息或 /resume 继续，/quit 退出。';this.emit('change');return id;
 }
 async models(id){return this.catalog.list(id?this.session(id).config:this.defaultModel);}
 modelProfile(id,value){
  const current=id?this.session(id).config:this.defaultModel;
  return {profile:this.catalog.resolve(value,current),current};
 }
 switchModel(id,value,options){
  if(this.offloadingKV)throw Error('Wait for the RAM KV operation to finish');
  if(this.modelSwitchPromise)throw Error('A model switch is already in progress');
  const pending=this.performModelSwitch(id,value,options);this.modelSwitchPromise=pending;pending.finally(()=>{this.modelSwitchPromise=null;}).catch(()=>{});return pending;
 }
 async performModelSwitch(id,value,{projectorDevice,initializing=false}={}){
  if(this.modelSwitching)throw Error('A model switch is already in progress');
  const session=id?this.session(id):null,current=session?.config??this.defaultModel,profile=this.catalog.resolve(value,current);
  // Resolve and validate before interrupting any live generation.
  const pendingSettings=this.catalog.settings(profile,current,{projectorDevice});this.pendingDefaultModel=pendingSettings;this.interruptActive();this.modelSwitching=true;const controller=new AbortController();this.modelSwitchController=controller;
  this.resident=null;this.checkpointRequested=false;
  this.ramKvResident=null;
  if(!initializing||!this.config.modelRuntime?.ramKv||current.model!==pendingSettings.model||current.projectorDevice!==pendingSettings.projectorDevice)
   for(const s of this.sessions.values())s.store.append('kv_invalidated',{reason:'model_switch',model:profile.model});
  this.notice='正在切换模型：'+profile.name;this.emit('change');
  try{
   await this.execution;controller.signal.throwIfAborted();this.acquire();
   const result=await this.catalog.activate(profile,current,{signal:controller.signal,projectorDevice});controller.signal.throwIfAborted();
   if(session)session.selectModel(result.settings,result.receipt);Object.assign(this.defaultModel,result.settings);
   atomic(path.join(this.root,'model-selection.json'),{id:profile.id,...result,time:Date.now()});
   this.notice='模型已切换到 '+profile.name+'；输入消息或 /resume 继续。';return result;
  }catch(error){this.notice='模型切换未完成：'+error.message;throw error;}
  finally{if(this.pendingDefaultModel===pendingSettings)this.pendingDefaultModel=null;this.modelSwitching=false;this.modelSwitchController=null;this.emit('change');}
 }
 effort(id,level,budget){const s=this.session(id);return level?s.requestEffort(level,budget):s.generationControls();}
 compact(id){id=this.resolveTaskId(id);
  const s=this.session(id),result=s.requestCompact();
  if(this.active!==id&&s.messages().filter(m=>m.role!=='system').length<2){s.store.append('compact_resolved',{request_seq:result.request_seq,status:'no_history'});this.emit('change');return {...result,pending:false,status:'no_history'};}
  if(this.active!==id){this.maintenance.set(id,this.status(id));this.manualNext=id;this.tick().catch(e=>{this.notice=e.message;this.emit('change');});}
  this.emit('change');return result;
 }
 priority(id,value){id=this.resolveTaskId(id);this.queue.priority(id,value);this.emit('change');}
 pause(id){id=this.resolveTaskId(id);const s=this.session(id);if(this.active===id)s.pause();else this.queue.settle(id,'paused',s.dependencies());this.emit('change');}
 resume(id){id=this.resolveTaskId(id);const s=this.session(id);if(this.active===id){if(s.pauseRequested&&this.holdResident){this.manualNext=id;this.start();}return;}if(s.store.pending().length&&!s.config.localRecovery)throw Error('Uncertain tool outcome requires evidence review before resume');if(this.status(id)==='correct')throw Error('Task is already correct');this.queue.enqueue(id,'resume');if(this.holdResident&&!this.enabled){this.manualNext=id;this.start();}this.emit('change');}
 retryLocally(id){
  const s=this.session(id);if(!s.config.localRecovery||s.pauseRequested)return false;
  const attempts=s.store.events.filter(e=>e.type==='local_session_recovery').length;
  if(attempts>=2||s.budget().millisecondsRemaining<=1000){this.queue.settle(id,'recovery_failed');return false;}
  s.store.append('local_session_recovery',{attempt:attempts+1,tools_replayed:false,time:Date.now()});this.queue.enqueue(id,'resume',{reason:'local_recovery'});return true;
 }
 feedback(id,candidate,status,note){id=this.resolveTaskId(id);const s=this.session(id);s.feedback(candidate,status,note);if(status==='correct'&&this.active!==id)this.queue.settle(id,'correct');else if(status==='incorrect'&&this.active!==id&&this.status(id)!=='paused')this.resume(id);this.emit('change');}
 async cancel(id,job){id=this.resolveTaskId(id);const result=await this.session(id).cancelCommand(job);await this.poll();this.emit('change');return result;}
 switchInference(id){id=this.resolveTaskId(id);this.session(id);if(this.active===id)return;if(this.status(id)==='correct')throw Error('Task already correct');if(this.session(id).store.pending().length)throw Error('Target has uncertain tools');this.manualNext=id;this.checkpointRequested=Boolean(this.active);if(this.active)this.session(this.active).requestYield();else this.resume(id);this.emit('change');}
 async checkpoint(id){id=this.resolveTaskId(id);if(this.active!==id)throw Error('KV can only be saved for the task currently owning inference');this.checkpointRequested=true;this.session(id).requestYield();}
 ramKvSettings(updates){
  if(!updates)return {enabled:Boolean(this.ramKvBasePolicy),...ramKvLimits({...this.ramKvBasePolicy,...this.ramKvOverrides})};
  const overrides={...this.ramKvOverrides};
  for(const [name,value] of Object.entries(updates)){
   if(!Object.hasOwn(RAM_KV_LIMIT_DEFAULTS,name))throw Error('未知 RAM KV 配置项：'+name);
   if(value===undefined)delete overrides[name];
   else overrides[name]=value;
  }
  const limits=ramKvLimits({...this.ramKvBasePolicy,...overrides});
  atomic(this.ramKvSettingsFile,overrides);
  this.ramKvOverrides=overrides;
  this.applyRamKvSettings(overrides);
  return {enabled:Boolean(this.ramKvBasePolicy),...limits};
 }
 applyRamKvSettings(overrides){
  if(this.ramKvBasePolicy)this.config.modelRuntime={...this.config.modelRuntime,ramKv:{...this.ramKvBasePolicy,...overrides}};
 }
 offloadKV(id){
  if(this.kvOperation)throw Error('Another RAM KV operation is in progress');
  const operation=this.performRamOffload(id);
  this.kvOperation=operation;
  operation.finally(()=>{this.kvOperation=null;}).catch(()=>{});
  return operation;
 }
 async performRamOffload(id){
  id=this.resolveTaskId(id);
  const session=this.session(id);
  if(this.offloadingKV||this.modelSwitching||this.closing)throw Error('Another model operation is in progress');
  if((this.active??this.resident)!==id)throw Error('只有当前驻留题的 KV 可以保存');
  if(!this.catalog.ramKvOwned?.(session.config))throw Error('当前引擎未启用 RAM KV。需通过 modelRuntime.ramKv 配置后重新启动引擎');
  this.offloadingKV=true;
  try{
   this.interruptActive();
   await this.execution;
   const ram=this.catalog.ramKvOwned(session.config);
   if(!ram||this.ramKvResident?.id!==id||this.ramKvResident.processId!==ram.processId||!this.lease)
    throw Error('未确认该题拥有当前槽位，已保留完整对话');
   const kv=new KvCache(session.config,{guard:this.guard,fetchFn:this.options.kvFetch||fetch,ram});
   return await kv.save(session);
  }finally{this.offloadingKV=false;this.emit('change');}
 }
 start(){if(this.bootError&&this.retryInitialization){this.retryInitialization().catch(()=>{});return;}this.enabled=true;this.notice='';if(!this.interval)this.interval=setInterval(()=>{this.tick().catch(e=>{this.notice=e.message;this.emit('change');});},1000);this.tick().catch(e=>{this.notice=e.message;this.emit('change');});this.emit('change');}
 async poll(){
  if(this.pollPromise)return this.pollPromise;
  this.polling=true;
  this.pollPromise=(async()=>{try{await Promise.all([...this.sessions].map(async([id,s])=>{if(id===this.active||!s.dependencies().length)return;const deps=await s.collect();if(!deps.length&&['waiting_tool','waiting_service'].includes(this.status(id)))this.queue.enqueue(id,'resume',{reason:'dependency_returned'});}));}finally{this.polling=false;this.pollPromise=null;}})();
  return this.pollPromise;
 }
 acquire(){
  this.guard();if(this.options.testMode||this.lease)return;
  const file=this.config.modelLease||path.join(DATA_ROOT,'model-lease.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file));if(live(prior.pid))throw Error('Model lease held by PID '+prior.pid);fs.renameSync(file,file+'.stale-'+Date.now());}
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,contestDir:this.root}),{flag:'wx',mode:0o600});this.lease=file;
 }
 release(){if(this.lease){fs.unlinkSync(this.lease);this.lease=null;}}
 async tick(){
  if(this.closing)return;await this.poll();this.emit('change');
  if(this.booting||this.modelSwitching||this.offloadingKV||(!this.enabled&&!this.maintenance.has(this.manualNext))||this.busy||(!this.manualNext&&!this.queue.state.readyResume.length&&!this.queue.state.readyFresh.length))return;
  this.busy=true;
  this.execution=this.dispatch();await this.execution;
 }
 async dispatch(){
  let id;const epoch=this.interruptEpoch;
  try{
   this.acquire();let item;
   if(this.manualNext){id=this.manualNext;this.manualNext=null;this.queue.remove(id);item={taskId:id,kind:'resume',priority:0,sequence:this.queue.state.next++};this.queue.state.running=item;this.queue.save();}else item=this.queue.take();
   if(!item)return;id=item.taskId;this.active=id;this.notice='';this.emit('change');const s=this.session(id);
   if(this.defaultModel.modelSelection){const profile=this.catalog.resolve(s.config.modelSelection??s.config.model,s.config);await this.catalog.activate(profile,s.config);}
   const kv=new KvCache(s.config,{guard:this.guard,fetchFn:this.options.kvFetch||fetch});
   const ram=this.catalog.ramKvOwned?.(s.config);
   const ramCache=ram&&new KvCache(s.config,{guard:this.guard,fetchFn:this.options.kvFetch||fetch,ram});
   const resident=this.resident===id&&(!ram||(this.ramKvResident?.id===id&&this.ramKvResident.processId===ram.processId));
   const restored=resident?{status:'resident'}:ramCache?await ramCache.restore(s):await kv.restore(s);
   if(restored.status!=='not_saved')s.store.append('checkpoint_restore',restored);
   this.ramKvResident=null;
   const previousRequest=s.store.events.findLast(event=>event.type==='model_accepted');
   const maintenanceOnly=this.maintenance.has(id),prior=this.maintenance.get(id);this.maintenance.delete(id);
   const result=epoch===this.interruptEpoch?await s.runSlice({maintenanceOnly}):{status:'paused',dependencies:s.dependencies()};this.resident=id;
   if(ram&&(resident||restored.status==='restored'||s.store.events.findLast(event=>event.type==='model_accepted')!==previousRequest))
    this.ramKvResident={id,processId:ram.processId};
   if(maintenanceOnly&&result.status==='awaiting_input')result.status=['ready_resume','ready_fresh'].includes(prior)?'ready':['waiting_tool','waiting_service','correct','awaiting_judge','awaiting_review','paused'].includes(prior)?prior:'awaiting_input';
   s.store.snapshot('conversation-checkpoint',{taskId:id,messages:s.messages(),time:Date.now()});
   if(this.checkpointRequested){const saved=await kv.save(s);s.store.append('checkpoint_result',saved);this.checkpointRequested=false;}
   this.queue.settle(id,result.status,result.dependencies||[]);
   if(result.status==='needs_review')this.retryLocally(id);
  }catch(e){this.notice=e.message;if(id){this.session(id).store.append('dispatch_error',{error:e.message});this.queue.settle(id,this.session(id).pauseRequested?'paused':'needs_review');this.retryLocally(id);}else this.enabled=false;}
  finally{
   this.active=null;
   if(!this.holdResident&&!this.ramKvResident){this.release();this.resident=null;}
   this.busy=false;this.emit('change');
  }
 }
 async close(){this.cancelInitialization?.();this.modelSwitchController?.abort();this.closing=true;this.enabled=false;clearInterval(this.interval);if(this.active)this.session(this.active).pause();await this.execution;await this.kvOperation?.catch(()=>{});await this.modelSwitchPromise?.catch(()=>{});await this.initialization?.catch(()=>{});while(this.polling)await new Promise(r=>setTimeout(r,10));this.release();if(fs.existsSync(this.lock))fs.unlinkSync(this.lock);}
}
