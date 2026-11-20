import fs from 'node:fs';
import path from 'node:path';
import {hash} from './store.mjs';

export const isRunning=data=>['started','starting','running','cancelling','terminating'].includes(data.status);
export function recordCursor(store,data,ref){
 if(!data.error&&Number.isInteger(data.stdout_next_offset)&&Number.isInteger(data.stderr_next_offset))store.append('job_output_cursor',{job_id:data.job_id,stdout_offset:data.stdout_next_offset,stderr_offset:data.stderr_next_offset,evidence_id:ref});
}
export function outputRoot(store,broker){return path.join(broker?.config?.workDir??store.root,'.tool-output');}
export function publishText(store,broker,text,key){
 const root=outputRoot(store,broker),name=hash(String(key)+'\0'+text).slice(0,20)+'.txt';
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const file=path.join(root,name);
 if(fs.realpathSync(root)!==root)throw Error('Output directory must be canonical');
 try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(fs.fstatSync(fd).isFile()&&fs.readFileSync(fd,'utf8')===text)return '/work/.tool-output/'+name;}finally{fs.closeSync(fd);}}catch(error){if(!['ENOENT','ELOOP'].includes(error.code))throw error;}
 const tmp=path.join(root,'.'+name+'.'+process.pid+'.tmp');
 const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,text);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);
 return '/work/.tool-output/'+name;
}
export function boundedText(store,broker,text,key,limit=12000){
 if(text.length<=limit)return text;
 let archived=text;
 try{
  const data=JSON.parse(text);
  if(typeof data.stdout==='string'||typeof data.stderr==='string')archived=[
   `Status: ${data.status??''}${data.job_id?' · '+data.job_id:''}${data.exit_code!==undefined?' · exit '+data.exit_code:''}`,
   ...(data.stdout_file?['Full stdout: '+data.stdout_file]:[]),...(data.stderr_file?['Full stderr: '+data.stderr_file]:[]),
   'stdout:',data.stdout??'',...(data.stderr?['stderr:',data.stderr]:[])
  ].join('\n');
 }catch{}
 const file=publishText(store,broker,archived,key);
 return archived.slice(0,limit)+`\n[Output truncated. Full output: ${file}. Use read to continue.]`;
}
export function commandOutput(store,broker,data){
 const result={status:isRunning(data)?'running':data.status??'error',...(data.job_id?{job_id:data.job_id}:{})};
 if(data.exit_code!==undefined)result.exit_code=data.exit_code;
 for(const name of ['stdout','stderr']){
  if(name==='stdout'||data[name])result[name]=data[name]??'';
  if(data[name+'_file'])result[name+'_file']=data[name+'_file'];
  if(data[name+'_truncated']&&data[name+'_path']){
   // Publish only command output, never the worker's private status record.
   const storage=broker?.jobStorageId?.(data.job_id);
   const file=storage&&broker?.config?.workDir&&path.join(broker.config.workDir,'.offline-jobs',storage,name);
   if(file&&fs.existsSync(file))result[name+'_file']=publishText(store,broker,fs.readFileSync(file,'utf8'),data.job_id+':'+name);
  }
 }
 if(data.error)result.error=data.error;
 if(data.execution_status)result.execution_status=data.execution_status;
 if(data.message)result.message=data.message;
 if(data.status==='unknown_exit')result.message='Job stopped; its exit code is unavailable. Inspect the output and files before deciding what to do next.';
 if(data.status==='unknown_launch')result.message='Launch status is uncertain. Use wait_job to observe this job.';
 if(data.status==='job_missing')result.message='No retained job record exists. Do not keep waiting; this job cannot be observed.';
 if(data.status==='job_record_missing')result.message='No retained job record exists after launch acknowledgement failed. Do not keep waiting; its state cannot be observed.';
 if(data.status==='launch_failed')result.message='The command did not start because sandbox job storage is unavailable.';
 return result;
}
export function submissionOutput(data){return {status:data.status,...(data.review_id?{review_id:data.review_id}:{}),...(data.message?{message:data.message}:{})};}

// Adapt retained transcripts at the read boundary. Raw journals and receipts are immutable.
export function presentMessages(store,broker,messages){
 return messages.map(original=>{
  const m=structuredClone(original);
  if(m.role==='assistant')for(const call of m.content??[]){
   if(call.type!=='toolCall')continue;
   if(call.name==='run_command')call.arguments={command:call.arguments.command};
   if(call.name==='wait_job')call.arguments={job_id:call.arguments.job_id};
   if(call.name==='submit_flag')call.arguments={candidate:call.arguments.candidate};
  }
  if(m.role==='toolResult'&&['run_command','wait_job','submit_flag'].includes(m.toolName)){
   m.content=(m.content??[]).map(block=>{
    if(block.type!=='text')return block;
    let data;try{data=JSON.parse(block.text);}catch{return block;}
    if(!data||typeof data!=='object')return block;
    if(data.preview!==undefined&&/^[a-f0-9]{64}$/.test(data.evidence_id??'')){
     const file=path.join(store.root,'artifacts',data.evidence_id);
     if(fs.existsSync(file))try{const raw=fs.readFileSync(file,'utf8');if(hash(raw)!==data.evidence_id)throw Error('Archived observation integrity mismatch');data=JSON.parse(raw);}catch{data=data.preview;}
     else try{data=JSON.parse(data.preview);}catch{data=data.preview;}
    }
    if(['run_command','wait_job'].includes(m.toolName))data=commandOutput(store,broker,data);
    else if(m.toolName==='submit_flag'){
     const candidate=store.events.find(e=>e.type==='candidate'&&e.data.id===data.submission_id);
     data=submissionOutput(candidate?{status:'awaiting_review',review_id:'c'+(store.events.filter(e=>e.type==='candidate'&&e.seq<=candidate.seq).length),message:'Saved for operator review in /queue.'}:data);
    }
    return {type:'text',text:boundedText(store,broker,typeof data==='string'?data:JSON.stringify(data),m.toolCallId)};
   });
  }
  return m;
 });
}
