import fs from 'node:fs';
import path from 'node:path';
import {hash, atomic} from './store.mjs';
import {toolError} from './tool-errors.mjs';
import {knowledgeTool,queryKnowledge} from './knowledge/tool.mjs';
import {fileReadTool} from './read.mjs';
import {boundedText,commandOutput,submissionOutput,recordCursor,isRunning} from './tool-output.mjs';

const string=(description,maxLength=1000)=>({type:'string',description,maxLength,minLength:1});
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});

export class VerdictChannel {
  constructor(taskId,outbox,inbox) {this.taskId=taskId;this.outbox=outbox;this.inbox=inbox;fs.mkdirSync(outbox,{recursive:true});}
  submit(callId,candidate) {
    const id=hash(this.taskId+'\0'+callId), candidateHash=hash(candidate);
    const file=path.join(this.outbox,id+'.json');
    if(!fs.existsSync(file))atomic(file,{id,task_id:this.taskId,candidate,candidate_sha256:candidateHash});
    return this.resolve(callId,candidate);
  }
  resolve(callId,candidate){
    const id=hash(this.taskId+'\0'+callId),candidateHash=hash(candidate);
    const request=JSON.parse(fs.readFileSync(path.join(this.outbox,id+'.json'),'utf8'));
    if(request.id!==id||request.task_id!==this.taskId||request.candidate!==candidate||request.candidate_sha256!==candidateHash)throw Error('Retained submission identity mismatch');
    const feedback=path.join(this.inbox,id+'.json');
    if(!fs.existsSync(feedback)) return {submission_id:id,status:'pending',candidate_sha256:candidateHash};
    const record=JSON.parse(fs.readFileSync(feedback,'utf8'));
    if(record.id!==id || record.candidate_sha256!==candidateHash || !['correct','incorrect'].includes(record.status)) throw Error('Verdict identity mismatch');
    return {submission_id:id,status:record.status}; // Never relay judge text or answer fields.
  }
}

export function buildTools(store,broker,knowledge,verdict,onSubmission=()=>{},options={}) {
  const remaining=()=>Math.max(0,Math.floor((options.remainingMs?.()??3600000)/1000));
  const tool=(name,description,parameters,operation)=>({name,label:name,description,parameters,executionMode:'sequential',
    execute:async(callId,args,signal)=>{
      const limit=Math.min(options.commandMaxSeconds??3600,remaining());
      if(name==='run_command'&&limit<1)throw Error('Solve time budget exhausted');
      if(name==='run_command'&&broker.checkCommand&&!store.events.some(e=>e.type==='tool_start'&&e.data.callId===callId))broker.checkCommand(args.command,limit);
      return store.execute(callId,name,args,async()=>{
        let data;
        const signals=[signal,options.signal?.()].filter(Boolean),control=signals.length?AbortSignal.any(signals):undefined;
        try {data=await operation(args,callId,control,limit);} catch(error) {
          if(name==='submit_flag')throw error;
          const job=store.events.findLast(e=>e.type==='job_launch_attempt'&&e.data.callId===callId)?.data;
          data=control?.aborted&&name==='wait_job'?{job_id:args.job_id,status:'running',message:'Observation interrupted. The job continues.'}:{error:toolError(store,name,callId,error),...(name==='wait_job'?{job_id:args.job_id}:job?{job_id:job.job_id,status:'unknown_launch'}:{})};
        }
        const ref=store.put(data,'tool:'+name);
        if(['run_command','wait_job'].includes(name))recordCursor(store,data,ref.id);
        const visible=['run_command','wait_job'].includes(name)?commandOutput(store,broker,data):name==='submit_flag'?submissionOutput(data):data;
        return {content:[{type:'text',text:boundedText(store,broker,JSON.stringify(visible),callId)}],details:{...(['run_command','wait_job'].includes(name)?{job_id:data.job_id,job_status:data.status}:{})}};
      });
    }});
  return [
    {name:'view_image',label:'view_image',description:'View a task PNG/JPEG within /work. Uses native vision; images count toward the context budget.',
      parameters:schema({path:string('Task image path inside /work',500)}),executionMode:'sequential',
      execute:async(id,a)=>store.execute(id,'view_image',a,async()=>{
        let image;try{image=await broker.image(a.path);}catch(error){return {content:[{type:'text',text:toolError(store,'view_image',id,error)}],isError:true};}
        store.put(image,'tool:view_image');
        return {content:[{type:'text',text:image.path},{type:'image',mimeType:image.mimeType,data:image.data}],details:{}};
      })},
    tool('run_command','Run a command in /work. Wait up to 15 seconds and return its output and exit code. If still running, return its job ID and new output; the command continues in the background.',
      schema({command:string('Shell command inside /work',16000)}),
      (a,id,signal,limit)=>broker.start(a.command,limit,id,Math.min(15,remaining()),signal)),
    tool('wait_job','Wait for an existing job and return new output. Each call waits up to 120 seconds. If still running, return a reminder; the job continues and you may wait again or do other work.',
      schema({job_id:string('Job ID returned by run_command, e.g. j1',32)}),async(a,id,signal)=>{
        const prior=store.events.findLast(e=>e.type==='job_output_cursor'&&e.data.job_id===a.job_id)?.data;
        const offsets={stdoutOffset:prior?.stdout_offset??0,stderrOffset:prior?.stderr_offset??0};
        const wait=Math.min(120,remaining()),data={...await broker.read(a.job_id,wait,offsets,signal),job_id:a.job_id};
        for(const name of ['stdout','stderr'])if(!Number.isInteger(data[name+'_next_offset'])){
          const bytes=Buffer.from(data[name]??''),offset=Math.min(offsets[name+'Offset'],bytes.length);
          data[name]=bytes.subarray(offset).toString('utf8');data[name+'_next_offset']=bytes.length;
        }
        if(isRunning(data))data.message=wait===120?'Still running after 120 seconds. The job continues; wait again or do other work.':'Still running. The job continues.';
        return data;
      }),
    fileReadTool(store,broker,knowledge,options),
    tool(knowledgeTool.function.name,knowledgeTool.function.description,knowledgeTool.function.parameters,queryKnowledge),
    tool('submit_flag',options.manualReview?'Save an exact candidate for the operator to submit and confirm in the frontend. Returns awaiting_review until the operator records the verdict.':'Submit an exact candidate to the configured judge. Returns correct, incorrect, or pending while the judge is processing.',
      schema({candidate:string('Exact candidate answer',4096)}),(a,id)=>{
        const result=verdict.submit(id,a.candidate),record={...result,call_id:id};onSubmission(record);store.append('submission',record);return result;
      })
  ];
}
