import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './text.mjs';

export const JOB_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const REQUEST_ID=/^[A-Za-z0-9_.:-]{1,200}$/;
export function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
export const requestHash=request=>digest(JSON.stringify(canonical(request)));
export class JobStore {
  constructor(directory){
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(fs.lstatSync(directory).isSymbolicLink())throw Error('Job directory must not be a symlink');
    this.root=fs.realpathSync(directory);this.lock=path.join(this.root,'.writer.lock');this.owner=randomUUID();
    try{this.acquire();}catch(error){if(error.code!=='EEXIST')throw error;const previous=this.readRaw('.writer.lock',4096);let alive=true;try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('Job directory already has a live writer');fs.unlinkSync(this.lock);this.acquire();}
  }
  acquire(){const fd=fs.openSync(this.lock,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,owner:this.owner}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}this.syncDirectory();}
  syncDirectory(){const fd=fs.openSync(this.root,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  readRaw(filename,limit=4194304){
    const fd=fs.openSync(path.join(this.root,filename),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('Invalid persisted job file');const bytes=fs.readFileSync(fd);if(bytes.length>limit)throw Error('Persisted job exceeds byte limit');return JSON.parse(bytes.toString('utf8'));}finally{fs.closeSync(fd);}
  }
  list(){return fs.readdirSync(this.root).filter(name=>name.endsWith('.json')).map(name=>{if(!JOB_ID.test(name.slice(0,-5)))throw Error('Unexpected job receipt filename');return this.read(name.slice(0,-5));});}
  read(id){
    if(!JOB_ID.test(id))throw Error('Invalid persisted job identifier');
    let envelope;try{envelope=this.readRaw(id+'.json');}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const record=envelope.record;
    if(envelope.version!==1||!record||digest(JSON.stringify(record))!==envelope.sha256||record.jobId!==id||!['queued','running','completed','failed','cancelled'].includes(record.status)||
       !Number.isFinite(record.createdAt)||record.requestHash!==requestHash(record.request)||
       (record.requestId!==undefined&&(typeof record.requestId!=='string'||!REQUEST_ID.test(record.requestId)))||
       (['completed','failed','cancelled'].includes(record.status)&&!Number.isFinite(record.finishedAt)))throw Error('Persisted job identity or state is invalid');
    return record;
  }
  write(job){
    const {controller,timer,...record}=job;
    const data=JSON.stringify({version:1,record,sha256:digest(JSON.stringify(record))})+'\n';
    if(Buffer.byteLength(data)>4194304)throw Error('Persisted job exceeds byte limit');
    const temp=path.join(this.root,'.'+job.jobId+'.'+randomUUID()+'.tmp');const fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(temp,path.join(this.root,job.jobId+'.json'));this.syncDirectory();}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  close(){if(!this.owner)return;const lock=this.readRaw('.writer.lock',4096);if(lock.owner!==this.owner)throw Error('Job writer lock identity changed');fs.unlinkSync(this.lock);this.syncDirectory();this.owner=null;}
}
