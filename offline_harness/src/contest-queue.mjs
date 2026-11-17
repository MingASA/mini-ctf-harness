import fs from 'node:fs';
import path from 'node:path';
import {atomic} from './store.mjs';
export class ContestQueue {
 constructor(root){
  fs.mkdirSync(root,{recursive:true});this.file=path.join(root,'queue.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,next:0,readyResume:[],readyFresh:[],waiting:{},parked:{},running:null};
  this.validate();
 }
 validate(){
  const s=this.state;if(s.version!==1)throw Error('Unknown contest queue version');
  const ids=[...s.readyResume,...s.readyFresh,...Object.values(s.waiting),...Object.values(s.parked),...(s.running?[s.running]:[])].map(x=>x.taskId);
  if(new Set(ids).size!==ids.length)throw Error('Task occurs in multiple queue states');
 }
 save(){this.validate();atomic(this.file,this.state);}
 item(id){const s=this.state;return [...s.readyResume,...s.readyFresh,...Object.values(s.waiting),...Object.values(s.parked),...(s.running?[s.running]:[])].find(x=>x.taskId===id);}
 remove(id){const s=this.state;s.readyResume=s.readyResume.filter(x=>x.taskId!==id);s.readyFresh=s.readyFresh.filter(x=>x.taskId!==id);delete s.waiting[id];delete s.parked[id];if(s.running?.taskId===id)s.running=null;}
 enqueue(id,kind='resume',{priority,reason='ready'}={}){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||!['fresh','resume'].includes(kind))throw Error('Invalid queue task/kind');
  if(priority!==undefined&&(!Number.isInteger(priority)||Math.abs(priority)>1000))throw Error('Invalid queue priority');
  const prior=this.item(id);if(this.state.running?.taskId===id)throw Error('Cannot requeue active task before its safe boundary');
  this.remove(id);const item={taskId:id,kind,priority:priority??prior?.priority??0,sequence:this.state.next++,reason};
  (kind==='fresh'?this.state.readyFresh:this.state.readyResume).push(item);this.save();return item;
 }
 take(){
  if(this.state.running)throw Error('A task already owns inference');
  const list=this.state.readyResume.length?this.state.readyResume:this.state.readyFresh;
  if(!list.length)return null;
  list.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
  const item=list.shift();this.state.running=item;this.save();return item;
 }
 settle(id,status,dependencies=[]){
  const prior=this.item(id);if(!prior)throw Error('Unknown queued task');this.remove(id);
  const item={...prior,status,dependencies};
  if(status==='ready'){
   item.kind='resume';item.sequence=this.state.next++;this.state.readyResume.push(item);
  }else if(status==='waiting_tool'||status==='waiting_service')this.state.waiting[id]=item;
  else this.state.parked[id]=item;
  this.save();
 }
 priority(id,value){if(!Number.isInteger(value)||Math.abs(value)>1000)throw Error('Priority must be -1000..1000');const item=this.item(id);if(!item)throw Error('Unknown task');item.priority=value;this.save();}
}
