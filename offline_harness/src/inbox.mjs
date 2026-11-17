import crypto from 'node:crypto';
export class TaskInbox {
 constructor(taskId,store){this.taskId=taskId;this.store=store;}
 enqueue(text,{id=crypto.randomUUID(),kind='human',evidence=[]}={}) {
  if(typeof text!=='string'||!text.trim()||text.length>16000)throw Error('Message must contain 1..16000 characters');
  if(!['human','observation','feedback'].includes(kind))throw Error('Unknown inbox message kind');
  const old=this.store.events.find(e=>e.type==='inbox_queued'&&e.data.id===id);
  if(old){if(old.data.text!==text||old.data.kind!==kind)throw Error('Inbox ID reused');return old.data;}
  const item={id,taskId:this.taskId,text,kind,evidence,created:Date.now()};
  this.store.append('inbox_queued',item);return item;
 }
 items(){
  const sent=new Map(this.store.events.filter(e=>e.type==='inbox_delivered').map(e=>[e.data.id,e.data]));
  const retired=new Set(this.store.events.filter(e=>e.type==='operator_note_retired').map(e=>e.data.id));
  return this.store.events.filter(e=>e.type==='inbox_queued').map(e=>({...e.data,status:sent.has(e.data.id)?'delivered':'queued',delivery:sent.get(e.data.id),retired:retired.has(e.data.id)}));
 }
 mount(messages){
  const present=new Set(messages.map(m=>m.harnessInboxId).filter(Boolean));
  for(const item of this.items().filter(x=>x.status==='queued')){
   if(present.has(item.id))continue;
   const existing=this.store.events.find(e=>e.type==='message'&&e.data.harnessInboxId===item.id)?.data;
   const message=existing||{role:'user',content:item.text,timestamp:item.created,harnessInboxId:item.id,harnessInboxKind:item.kind,taskId:this.taskId};
   if(!existing)this.store.append('message',message);
   messages.push(structuredClone(message));present.add(item.id);
  }
  return messages;
 }
 accepted({requestId,inboxIds}){
  const queued=new Set(this.items().filter(i=>i.status==='queued').map(i=>i.id));
  for(const id of new Set(inboxIds))if(queued.has(id))this.store.append('inbox_delivered',{id,taskId:this.taskId,requestId});
 }
 retire(id){
  const item=this.items().find(x=>x.id===id);if(!item||item.status!=='delivered')throw Error('Only a delivered note can be archived');
  this.store.append('operator_note_retired',{id,taskId:this.taskId});
 }
}
