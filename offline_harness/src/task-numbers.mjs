import fs from 'node:fs';
import path from 'node:path';
import {atomic} from './store.mjs';
const number=n=>String(n).padStart(2,'0');
export class TaskNumbers {
 constructor(root,ids=[]){
  this.file=path.join(root,'task-numbers.json');
  const fresh=!fs.existsSync(this.file);
  this.state=!fresh?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,next:1,ids:{}};
  const s=this.state,values=Object.values(s.ids??{});
  if(s.version!==1||!Number.isSafeInteger(s.next)||s.next<1||new Set(values).size!==values.length||values.some(v=>!/^\d+$/.test(v)||Number(v)<1))throw Error('Invalid task numbering index');
  // Reserve explicit numeric task IDs before assigning aliases to legacy IDs.
  for(const id of ids.filter(id=>/^\d+$/.test(id)))this.assign(id);
  for(const id of ids){
   if(fresh&&!Object.hasOwn(this.state.ids,id)){let n=1;while(Object.values(this.state.ids).includes(number(n)))n++;this.state.ids[id]=number(n);this.state.next=Math.max(this.state.next,n+1);atomic(this.file,this.state);}
   else this.assign(id);
  }
 }
 assign(id){
  if(Object.hasOwn(this.state.ids,id))return this.state.ids[id];
  let value;
  if(/^\d+$/.test(id)){
   const n=Number(id);if(!Number.isSafeInteger(n)||n<1)throw Error('Invalid numeric task ID');value=number(n);
   if(Object.values(this.state.ids).includes(value))throw Error('Task number is already assigned');
   this.state.next=Math.max(this.state.next,n+1);
  }else value=this.next();
  this.state.ids[id]=value;atomic(this.file,this.state);return value;
 }
 next(){while(Object.values(this.state.ids).includes(number(this.state.next)))this.state.next++;return number(this.state.next++);}
 allocate(){const id=this.next();this.state.ids[id]=id;atomic(this.file,this.state);return id;}
 label(id){return id?(this.state.ids[id]??id):id;}
 resolve(value,records){
  if(records.has(value))return value;
  const target=/^\d+$/.test(String(value))?number(Number(value)):String(value);
  const id=Object.keys(this.state.ids).find(id=>this.state.ids[id]===target&&records.has(id));
  if(!id)throw Error('Unknown task '+value);return id;
 }
}
