import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Store,atomic,hash} from './store.mjs';
import {TeamTransport,lanOrigin} from './team-transport.mjs';

const centerPrompt=`You are the team's CENTER, a normal interactive agent with all ordinary tools. Maintain a global understanding of this challenge. Distinguish verified facts, observations, hypotheses and failed attempts. Use team_graph to maintain concise Markdown Fact and Intent graphs; give facts IDs/evidence references and ground each intent in facts. Revise intents when evidence contradicts assumptions. You decide the graph and task decomposition, not the harness.
Use team_message to assign complementary, appropriately sized directions to numbered workers. Your main value is planning, correcting false premises, integrating evidence and organizing work; delegate concrete exploration when useful, while retaining freedom to inspect materials and verify findings yourself. On help/finish/handoff, inspect relevant original messages or evidence with team_read when necessary, identify loops or local thinking, update the graph and give useful guidance. Do not assume a queued message was delivered or that a worker's claim is verified. You may keep exploring after dispatch, but do not busy-poll: a final response waits for worker messages or human input. Human corrections take precedence.`;
const workerPrompt=`You are a WORKER collaborating with a Center on this challenge. Preserve your normal autonomous solving methods and tools. Follow the assigned direction, distinguish observed facts from hypotheses, avoid repeating failed attempts, and use mature installed tools. Use team_message(kind=help) promptly when stuck, and kind=finish after a useful round of exploration. Include concise actual findings, failures and evidence references; never fabricate a result. These reports wait for new guidance. You can read the Center's Fact/Intent graph and fetch its files with team_graph/team_read. Communicate only with the Center, never other workers.
If the operator requests /handoff or /help, stop exploring after the current complete turn and give a useful final report; the harness sends that final text to the Center automatically. Handoff should be brief and factual, with important evidence paths, unsuccessful approaches and remaining unknowns. Help should describe the blocker, relevant evidence and what assistance is needed. Do not send the same report twice.`;
const textSchema=description=>({type:'string',description});
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}],details:data});
const nonempty=value=>{if(typeof value!=='string'||!value.trim())throw Error('Nonempty text is required');return value;};
function page(values,offset=0,limit=20){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid page offset/limit');
 return {items:values.slice(offset,offset+limit),total:values.length,next_offset:offset+limit<values.length?offset+limit:null};
}

// Role/session bindings live separately from immutable model and sandbox configuration.
export class Team {
 constructor(contest){
  this.contest=contest;this.root=path.join(contest.root,'team');this.store=new Store(this.root);this.file=path.join(this.root,'state.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)): {bindings:[],ready:false,workerTask:null};
  this.transport=new TeamTransport(path.join(this.root,'network'),contest.config.team,{receive:m=>this.receive(m),read:q=>this.read(q),info:()=>({ready:this.state.ready})});
  this.transport.on('change',()=>contest.emit('change'));
  this.transport.on('sent',receipt=>{try{this.receipt(receipt);}catch(error){this.transport.error=error.message;}});
 }
 save(){atomic(this.file,this.state);this.contest.emit('change');}
 binding(taskId){return this.state.bindings.find(b=>b.taskId===taskId);}
 byTeam(id){return this.state.bindings.find(b=>b.teamId===id);}
 session(b){if(this.contest.deleting.has(b.taskId))throw Error('Team task is being deleted');return this.contest.session(b.taskId);}
 async start(){await this.transport.start();for(const e of this.transport.store.events.filter(e=>e.type==='sent'))this.receipt(e.data);return this;}
 receipt(receipt){
  const m=this.transport.store.events.find(e=>e.type==='outgoing'&&e.data.message.id===receipt.id)?.data.message;
  if(m?.kind!=='invite')return;
  const b=this.byTeam(m.teamId),member=b?.workers?.find(w=>w.id===receipt.to);if(!member)return;
  if(!member.joined){member.joined=true;this.save();}
  this.deliver(b,{id:'joined-'+m.id,kind:'joined',from:{id:member.id,name:'Worker '+member.number},text:'Worker '+member.number+' ('+member.name+') has joined and can receive tasks. Choose a complementary direction based on the current facts. Any existing work can be requested via handoff.'});
 }
 forgetTask(taskId){this.state.bindings=this.state.bindings.filter(b=>b.taskId!==taskId);if(this.state.workerTask===taskId){this.state.workerTask=null;this.state.ready=false;}this.save();}
 async close(){await this.transport.close();}
 prompt(taskId){const b=this.binding(taskId);return b?'\n\n'+(b.role==='center'?centerPrompt:workerPrompt)+'\nTeam ID: '+b.teamId+'; local role: '+b.role+'. Team messages target this main session only; /btw is local discussion and cannot send team reports or edit the graph.':'';}
 status(taskId){
  const b=this.binding(taskId);return {node:this.transport.self(),ready:this.state.ready,binding:b??null,pending:this.transport.pending().length,errors:Object.fromEntries(this.transport.errors),error:this.transport.error,discovery_error:this.transport.discoveryError};
 }
 line(taskId){const b=this.binding(taskId);return b?`团队 ${b.role} · 待投递 ${this.transport.pending().length}${this.transport.errors.size?' · 通信待重试':''}`:'';}
 async center(taskId,report=''){
  const existing=this.binding(taskId);if(existing){if(existing.role!=='center')throw Error('This session is already a worker');return existing;}
  const s=this.contest.session(taskId),b={teamId:crypto.randomUUID(),taskId,role:'center',workers:[]};
  this.state.bindings.push(b);if(this.state.workerTask===taskId){this.state.ready=false;this.state.workerTask=null;}this.save();
  this.updateGraph(b,'','');s.requestYield();
  this.deliver(b,{id:'center-'+b.teamId,kind:'setup',from:this.transport.self(),text:'You are now the team Center. Establish the facts and intents; assign directions when workers join.'+(report&&report!=='-'?'\nOperator supplied scouting report (verify claims as needed):\n'+report:'')});
  return b;
 }
 worker(taskId){
  if(taskId&&this.binding(taskId))throw Error('This session already belongs to a team; use /team worker new to accept a different challenge');
  if(taskId)this.contest.session(taskId);
  this.state.ready=true;this.state.workerTask=taskId??null;this.save();return this.status(taskId);
 }
 async connect(taskId,url){
  const b=this.binding(taskId);if(!b)throw Error('Run /team center or join a team on this session first');
  const peer=await this.transport.request(lanOrigin(url),'/info');
  if(typeof peer.id!=='string'||peer.id===this.transport.id)throw Error('Invalid peer identity');
  if(b.role==='worker'){if(peer.id!==b.center.id)throw Error('This is not the bound Center');b.center.url=lanOrigin(url);this.transport.relocate(b.center);this.save();return b.center;}
  let member=b.workers.find(p=>p.id===peer.id);
  if(!member&&!peer.ready)throw Error('Worker must opt in with /team worker first');
  if(!member){member={id:peer.id,name:peer.name,url:lanOrigin(url),number:b.workers.length+1};b.workers.push(member);this.save();}
  else if(member.url!==lanOrigin(url)){member.url=lanOrigin(url);this.save();this.transport.relocate(member);}
  const record=this.contest.records.get(taskId);
  this.transport.queue(member,{id:'invite-'+b.teamId+'-'+peer.id,teamId:b.teamId,kind:'invite',text:record.task.objective,title:record.title,target:record.target??'',attachments:record.attachments??[]});
  return member;
 }
 async discover(taskId){
  const peers=await this.transport.discover(),joined=[];
  for(const peer of peers){if(!peer.ready)continue;try{joined.push(await this.connect(taskId,peer.url));}catch(error){joined.push({name:peer.name,error:error.message});}}
  return joined;
 }
 peer(b,worker){
  if(b.role==='worker'){if(worker!==undefined&&worker!=='center')throw Error('Workers communicate only with Center');return b.center;}
  const p=b.workers.find(p=>String(p.number)===String(worker));if(!p)throw Error('Unknown worker; team_message(action=status) lists worker numbers');return p;
 }
 async receive(m){
  if(this.contest.closing)throw Error('Harness is closing; retry later');
  if(m.kind==='invite'){
   let b=this.byTeam(m.teamId);
   if(b){if(b.role!=='worker'||b.center.id!==m.from.id)throw Error('Team invitation identity conflict');}
   else{
    if(!this.state.ready)throw Error('Worker has not opted in; use /team worker');
    const taskId=this.state.workerTask??'team-'+hash(m.teamId).slice(0,24);
    if(this.binding(taskId))throw Error('Session already belongs to a team');
    if(!this.contest.records.has(taskId)){
     await this.contest.add({id:taskId,title:m.title,objective:nonempty(m.text),target:m.target??'',signal:this.transport.controller.signal});
     this.contest.queue.settle(taskId,'awaiting_input');
    }
    b={teamId:m.teamId,taskId,role:'worker',center:m.from};this.state.bindings.push(b);this.state.ready=false;this.state.workerTask=null;this.save();
   }
   this.session(b).requestYield();
   this.deliver(b,{...m,text:'Joined the Center for this challenge. Wait for an assigned direction, or send a factual handoff of existing work.\nChallenge: '+m.text+'\nCenter target: '+(m.target||'(none)')+'; this existing local session target: '+(this.contest.records.get(b.taskId).target||'(none)')+'. If they differ, ask the operator to check the local challenge environment before making network assumptions.'+'\nCenter attachments (use team_read source=file to fetch into /work): '+JSON.stringify(m.attachments??[])});
   return {taskId:b.taskId};
  }
  const b=this.byTeam(m.teamId);if(!b)throw Error('Unknown team');
  const peer=b.role==='worker'?b.center:b.workers.find(p=>p.id===m.from.id);
  if(!peer||peer.id!==m.from.id)throw Error('Sender is not a member of this team');
  const allowed=b.role==='worker'?['task']:['help','finish','handoff'];if(!allowed.includes(m.kind))throw Error('Message kind is not allowed for this role');
  nonempty(m.text);
  this.deliver(b,{...m,from:{...peer,name:peer.number?'Worker '+peer.number:peer.name}});return {taskId:b.taskId};
 }
 deliver(b,m){
  const s=this.session(b),prior=s.inbox.items().find(i=>i.id==='team-'+m.id);s.enqueue(`[Team ${m.kind} from ${m.from.name??m.from.id}; message ${m.id}]\n${m.text}`,{id:'team-'+m.id,kind:'observation'});
  if(prior?.status==='delivered')return;
  // Explicit pause/review/correct/budget states are never overridden by remote traffic.
  if(['awaiting_input','awaiting_judge','awaiting_review','idle','waiting_tool','waiting_service'].includes(this.contest.status(b.taskId)))this.contest.queue.enqueue(b.taskId,'resume',{reason:'team_message'});
  this.contest.emit('change');
 }
 send(b,kind,text,worker,id=crypto.randomUUID()){
  if(!(b.role==='center'?['task']:['help','finish','handoff']).includes(kind))throw Error('Use task as Center; help, finish or handoff as Worker');
  return this.transport.queue(this.peer(b,worker),{id,teamId:b.teamId,kind,text:nonempty(text)});
 }
 graph(b){return this.store.events.findLast(e=>e.type==='graph'&&e.data.teamId===b.teamId)?.data??{teamId:b.teamId,facts:'',intents:''};}
 updateGraph(b,facts,intents){
  if(b.role!=='center')throw Error('Only Center can edit the graph');
  if(typeof facts!=='string'||typeof intents!=='string')throw Error('Supply Markdown facts and intents');
  const graph={teamId:b.teamId,facts,intents};this.store.append('graph',graph);this.contest.emit('change');return graph;
 }
 requestReport(taskId,kind,note=''){
  const b=this.binding(taskId);if(b?.role!=='worker'||!['help','handoff'].includes(kind))throw Error('This command needs a joined Worker session');
  const s=this.session(b);if(this.pendingReport(b))throw Error('A report is already requested');
  const id=crypto.randomUUID(),text=(kind==='handoff'?'Operator requests handoff. Stop further exploration and write a concise factual handoff.':'Operator requests help. Stop further exploration and clearly describe the blocker and the assistance needed.')+' Your next final text will be sent to Center automatically. Do not call team_message for this same report.'+(note?'\nOperator note: '+note:'');
  s.store.append('team_report_requested',{id,kind});s.enqueue(text,{id,kind:'observation'});s.requestYield();
  if(!['running','paused','needs_review','correct','budget_exhausted'].includes(this.contest.status(taskId)))this.contest.queue.enqueue(taskId,'resume');
  return {id,kind,status:'queued'};
 }
 pendingReport(b){const s=this.session(b);return s.store.events.findLast(e=>e.type==='team_report_requested'&&!s.store.events.some(d=>d.type==='team_report_sent'&&d.data.id===e.data.id))?.data;}
 finishTurn(taskId,message){
  const b=this.binding(taskId);if(b?.role!=='worker')return false;
  const s=this.session(b),pending=this.pendingReport(b);
  if(pending&&message.stopReason==='stop'&&!message.harnessTruncated&&!message.harnessOutputTruncated&&s.inbox.items().some(i=>i.id===pending.id&&i.status==='delivered')){
   const text=(message.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim();
   if(text){this.send(b,pending.kind,text,undefined,'report-'+pending.id);s.store.append('team_report_sent',{id:pending.id});return !s.inbox.items().some(i=>i.status==='queued');}
  }
  const wait=s.store.events.findLast(e=>e.type==='team_report_wait');
  if(wait&&!s.store.events.some(e=>e.type==='team_report_waited'&&e.data.seq===wait.seq)){
   s.store.append('team_report_waited',{seq:wait.seq});return !pending&&!s.inbox.items().some(i=>i.status==='queued');
  }
  return false;
 }
 authorize(q){
  const b=this.byTeam(q.teamId);if(!b)throw Error('Unknown team');
  if(!(b.role==='center'?b.workers.some(w=>w.id===q.nodeId):b.center.id===q.nodeId))throw Error('Evidence requester is not a member');
  return b;
 }
 async read(q){
  const b=this.authorize(q),s=this.session(b);
  if(q.source==='graph')return this.graph(b);
  if(q.source==='messages')return page(s.store.events.filter(e=>e.type==='message').map(e=>({seq:e.seq,message:e.data})),q.offset,q.limit);
  if(q.source==='journal')return page(s.store.events.filter(e=>['message','tool_start','tool_done','artifact','job_started','job_output_cursor','candidate','submission','inbox_queued','inbox_delivered'].includes(e.type)),q.offset,q.limit);
  if(q.source==='artifact'){
   if(!/^[a-f0-9]{64}$/.test(q.ref)||!s.store.events.some(e=>e.type==='artifact'&&e.data.id===q.ref))throw Error('Unknown evidence artifact');
   const text=fs.readFileSync(path.join(s.store.root,'artifacts',q.ref),'utf8');if(hash(text)!==q.ref)throw Error('Evidence integrity failure');
   const p=page(text,q.offset??0,q.limit??4000);return {...p,text:p.items,items:undefined};
  }
  if(q.source==='file'){
   if(typeof q.ref!=='string'||!q.ref.startsWith('/work/'))throw Error('File reference must be inside this task /work');
   const root=fs.realpathSync(s.config.sandbox.workDir),file=fs.realpathSync(path.resolve(root,q.ref.slice(6)));
   if(!file.startsWith(root+path.sep))throw Error('File escapes task workspace');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{
    if(!fs.fstatSync(fd).isFile())throw Error('Only regular task files can be shared');
    // Resolve the opened descriptor too, protecting against a changed parent symlink on Linux.
    if(process.platform==='linux'&&!fs.realpathSync('/proc/self/fd/'+fd).startsWith(root+path.sep))throw Error('File escapes task workspace');
    return {stream:fs.createReadStream(file,{fd,autoClose:true})};
   }catch(error){fs.closeSync(fd);throw error;}
  }
  throw Error('Unknown evidence source');
 }
 async remoteRead(b,{worker,source,ref,offset,limit},callId,signal){
  const peer=this.peer(b,worker),q={teamId:b.teamId,nodeId:this.transport.id,source,ref,offset,limit};
  if(source!=='file')return this.transport.request(peer.url,'/read',q,{signal});
  const s=this.session(b),work=fs.realpathSync(s.config.sandbox.workDir),directory=path.join(work,'team-import');fs.mkdirSync(directory,{recursive:true});
  const basename=hash(callId)+'-'+path.basename(ref??'file'),temp=path.join(this.root,crypto.randomUUID()+'.download');
  let dirfd;
  try{
   const response=await this.transport.request(peer.url,'/read',q,{raw:true,signal});
   await pipeline(response.body,fs.createWriteStream(temp,{flags:'wx',mode:0o600}),{signal});
   const digest=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(temp,{signal}))digest.update(bytes);
   signal?.throwIfAborted();
   dirfd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
   const targetDir=process.platform==='linux'?'/proc/self/fd/'+dirfd:directory;
   if(!fs.fstatSync(dirfd).isDirectory()||fs.realpathSync(targetDir)!==directory)throw Error('Import directory changed or is a symlink');
   const destination=path.join(targetDir,basename);
   fs.copyFileSync(temp,destination,fs.constants.COPYFILE_EXCL);
   // A concurrent workspace command may rename the directory. Never report a stale local path.
   if(fs.realpathSync(directory)!==directory||fs.statSync(directory).ino!==fs.fstatSync(dirfd).ino){fs.unlinkSync(destination);throw Error('Import directory changed during transfer; retry');}
   return {path:'/work/team-import/'+basename,sha256:digest.digest('hex'),bytes:fs.statSync(destination).size,from:peer.id,source:ref};
  }finally{if(dirfd!==undefined)fs.closeSync(dirfd);fs.rmSync(temp,{force:true});}
 }
 tools(taskId){
  const b=this.binding(taskId);if(!b)return [];
  const s=this.session(b),tool=(name,description,parameters,op)=>({name,label:name,description,parameters,execute:(id,args,signal)=>s.store.execute(id,name,args,async()=>{
   try{const signals=[signal,s.requestSignal].filter(Boolean);return result(await op(args,id,signals.length?AbortSignal.any(signals):undefined));}catch(error){return {...result({error:error.message}),isError:true};}
  })});
  return [
   tool('team_message',b.role==='center'?'List workers with action=status, or assign a direction/guidance with action=send, worker number, kind=task and text. Sending queues durable delivery; Center may continue thinking.':'Use action=send and kind=help|finish|handoff with a concise factual text to contact Center and wait for guidance. action=status shows communication state.',schema({action:{enum:['status','send']},worker:textSchema('Worker number (Center only); omit as Worker'),kind:{enum:b.role==='center'?['task']:['help','finish','handoff']},text:textSchema('Task/guidance or concise report with evidence references')},['action']),async(a,id)=>{
    if(a.action==='status')return this.status(taskId);if(a.action!=='send')throw Error('Unknown action');
    const sent=this.send(b,a.kind,a.text,a.worker,hash(b.teamId+'\0'+taskId+'\0'+id));
    if(b.role==='worker'){const pending=this.pendingReport(b);if(pending&&pending.kind===a.kind&&s.inbox.items().some(i=>i.id===pending.id&&i.status==='delivered'))s.store.append('team_report_sent',{id:pending.id});s.store.append('team_report_wait',{});}
    return sent;
   }),
   tool('team_graph','Read the shared Fact/Intent graph. Center can replace its Markdown facts/intents with action=update; preserve useful facts and cite evidence. Intents should reference facts. No planning is performed by the harness.',schema({action:{enum:b.role==='center'?['read','update']:['read']},facts:textSchema('Markdown reliable facts and evidence references'),intents:textSchema('Markdown directions, assignments, dependencies and supporting fact IDs')},['action']),(a,id,signal)=>{
    if(a.action==='update')return this.updateGraph(b,a.facts,a.intents);if(a.action!=='read')throw Error('Unknown action');
    return b.role==='center'?this.graph(b):this.remoteRead(b,{source:'graph'},id,signal);
   }),
   tool('team_read','Read a teammate’s original messages/journal/artifact in pages, or fetch a /work file into your local /work/team-import. Center supplies worker number; Worker reads Center. Defaults: 20 events or 4000 artifact characters; use next_offset for more. File results give a local path for ordinary tools.',schema({worker:textSchema('Worker number, Center only'),source:{enum:['messages','journal','artifact','file']},ref:textSchema('Artifact SHA256 or absolute /work path'),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}},['source']),(a,id,signal)=>this.remoteRead(b,a,id,signal))
  ];
 }
}
