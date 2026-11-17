import fs from 'node:fs';
import path from 'node:path';
function atomic(file,value){const tmp=file+'.clock-tmp';fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
const boot=()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const mono=()=>Number(process.hrtime.bigint())/1e6;
export function processIdentity(pid=process.pid){try{const f=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');return {pid,start_ticks:Number(f[19]),state:f[0]};}catch{return null;}}
function alive(owner){const p=processIdentity(owner?.pid);return p&&p.start_ticks===owner.start_ticks&&p.state!=='Z';}
export const budgetPath=store=>path.join(store.root,'solve-budget.json');
// Leave cancellation/observer latency inside the declared long-task maximum.
export const stopReserveMs=config=>config.budgetMode==='active_solve'&&config.maxSeconds>=60?1000:0;
const retryWait=new Int32Array(new SharedArrayBuffer(4));
export function readSolveBudget(file,{allowMissing=false}={}){
 let missing;
 for(let attempt=0;attempt<=20;attempt++){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;missing=error;if(attempt<20)Atomics.wait(retryWait,0,0,5);}
 }
 if(allowMissing)return null;
 throw missing;
}
export function activeBudgetView(snapshot,{monotonicMs=mono(),bootId=boot()}={}){
 if(!snapshot)return null;
 let used=snapshot.used_ms;
 if(snapshot.active){
  if(snapshot.boot_id===bootId&&alive(snapshot.owner))used=snapshot.used_before_segment_ms+Math.max(0,monotonicMs-snapshot.started_monotonic_ms);
  else used+=snapshot.crash_uncertainty_ms??1000;
 }
 return {...snapshot,used_ms:used,remaining_ms:Math.max(0,snapshot.budget_ms-used),owner_alive:snapshot.active?Boolean(alive(snapshot.owner)):false};
}
export function taskClock(store,config,options={}){
 if(config.budgetMode!=='active_solve')return wallClock(store,config,options);
 const now=options.now??Date.now();let meta=store.events.find(e=>e.type==='active_solve_clock')?.data;
 if(!meta&&options.start){meta={started_unix:options.startedUnix??now/1000,budget_ms:config.maxSeconds*1000,scope:'inference_tools_wait_and_compact_only',version:2};store.append('active_solve_clock',meta);}
 const budget=meta?.budget_ms??config.maxSeconds*1000;if(budget!==config.maxSeconds*1000)throw Error('Solve budget changed');
 const closed=store.events.filter(e=>e.type==='solve_segment_end').reduce((n,e)=>n+e.data.elapsed_ms,0);
 const open=store.events.findLast(e=>e.type==='solve_segment_start'&&!store.events.some(x=>x.type==='solve_segment_end'&&x.data.start_seq===e.seq));
 let used=closed,active=false;
 if(open){
  if(open.data.boot_id===boot()&&alive(open.data.owner)){used+=Math.max(0,(options.monotonicMs??mono())-open.data.started_monotonic_ms);active=true;}
  else {
   const saved=readSolveBudget(budgetPath(store));
   if(saved.segment_seq!==open.seq)throw Error('Solve checkpoint does not match the open interval');
   used=Math.max(used,saved.used_ms+(saved.active?(saved.crash_uncertainty_ms??1000):0));
  }
 }
 const compactionMs=store.events.filter(e=>e.type==='compact_start').reduce((n,e)=>{const end=store.events.find(x=>x.type==='compact_end'&&x.data.start_seq===e.seq);return n+(end?.data.elapsed_ms??(active&&open&&e.seq>open.seq?Math.max(0,now-e.time):0));},0);
 const remaining=Math.max(0,budget-used);
 return {started:Boolean(meta),startedUnix:meta?.started_unix,deadlineUnix:active?(now+remaining)/1000:null,millisecondsRemaining:remaining,elapsedSolveMs:used,elapsedWallMs:meta?Math.max(0,now-meta.started_unix*1000):0,compactionMs,active,budgetScope:'active_solve'};
}
export function beginSolve(store,config){
 if(config.budgetMode!=='active_solve')return null;
 const previous=store.events.findLast(e=>e.type==='solve_segment_start'&&!store.events.some(x=>x.type==='solve_segment_end'&&x.data.start_seq===e.seq));
 if(previous){
  if(previous.data.boot_id===boot()&&alive(previous.data.owner)){if(previous.data.owner.pid===process.pid)return previous;throw Error('Solve segment is still owned');}
  const before=taskClock(store,config),closed=store.events.filter(e=>e.type==='solve_segment_end').reduce((n,e)=>n+e.data.elapsed_ms,0);
  store.append('solve_segment_end',{start_seq:previous.seq,elapsed_ms:Math.max(0,before.elapsedSolveMs-closed),reason:'recovered_dead_owner',uncertainty_ms:1000});
 }
 const state=taskClock(store,config);if(!state.millisecondsRemaining)throw Error('Run wall-time budget exhausted');
 const event=store.append('solve_segment_start',{owner:processIdentity(),boot_id:boot(),started_monotonic_ms:mono(),used_before_segment_ms:state.elapsedSolveMs,budget_ms:config.maxSeconds*1000});
 checkpointSolve(store,config,event);return event;
}
export function checkpointSolve(store,config,event){
 if(!event)return;
 const state=taskClock(store,config);atomic(budgetPath(store),{version:2,scope:'active_solve',active:state.active,segment_seq:event.seq,budget_ms:config.maxSeconds*1000,used_ms:state.elapsedSolveMs,...event.data,crash_uncertainty_ms:1000,observed_unix:Date.now()/1000});
}
export function endSolve(store,config,event,reason='segment_end'){
 if(!event||store.events.some(e=>e.type==='solve_segment_end'&&e.data.start_seq===event.seq))return;
 store.append('solve_segment_end',{start_seq:event.seq,elapsed_ms:Math.max(0,mono()-event.data.started_monotonic_ms),reason});checkpointSolve(store,config,event);
}
// A single durable wall deadline is shared by runner, UI and outer campaign.
// Phase/processing durations are diagnostics, never separate remaining budgets.
function wallClock(store,config,{now=Date.now(),startedUnix,deadlineUnix,start=false}={}){
 const prior=store.events.find(e=>e.type==='task_clock')?.data;
 let first=prior?.started_unix??startedUnix;
 let deadline=prior?.deadline_unix??deadlineUnix;
 if(prior&&((startedUnix!==undefined&&startedUnix!==first)||(deadlineUnix!==undefined&&deadlineUnix!==deadline)))throw Error('Task deadline changed');
 if(first===undefined){const legacy=store.events.find(e=>['execution_start','slice_start'].includes(e.type));first=legacy?legacy.time/1000:start?now/1000:undefined;}
 if(first===undefined)return {started:false,millisecondsRemaining:config.maxSeconds*1000,elapsedWallMs:0,compactionMs:0};
 deadline??=first+config.maxSeconds;
 if(![first,deadline].every(Number.isFinite)||deadline<first)throw Error('Invalid task deadline');
 if(!prior&&start)store.append('task_clock',{started_unix:first,deadline_unix:deadline,budget_seconds:config.maxSeconds,scope:'wall_including_prepare_tools_compact_and_repair'});
 const lastEnd=store.events.findLast(e=>e.type==='task_clock_end');
 let resumed=store.events.findLast(e=>e.type==='task_clock_resume');
 if(start&&lastEnd&&lastEnd.seq>(resumed?.seq??-1))resumed=store.append('task_clock_resume',{original_deadline_unix:deadline});
 const ended=lastEnd&&lastEnd.seq>(resumed?.seq??-1)?lastEnd:undefined;
 const effectiveNow=ended?Math.min(now,ended.time):now;
 const compactionMs=store.events.filter(e=>e.type==='compact_start').reduce((sum,e)=>{
  const end=store.events.find(x=>x.type==='compact_end'&&x.data.start_seq===e.seq);return sum+(end?.data.elapsed_ms??Math.max(0,effectiveNow-e.time));
 },0);
 return {started:true,startedUnix:first,deadlineUnix:deadline,millisecondsRemaining:Math.max(0,deadline*1000-effectiveNow),elapsedWallMs:Math.max(0,effectiveNow-first*1000),compactionMs};
}
