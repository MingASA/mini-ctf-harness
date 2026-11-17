import {getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools} from '@earendil-works/pi-ai';
import {hash} from './store.mjs';
import {boundedText,presentMessages} from './tool-output.mjs';
import {compactPrompt,validateCompact} from './compact-prompts.mjs';

export function wire(messages,{includeProvenance=false}={}) {
  const parts = value => typeof value === 'string' ? [{type:'text',text:value}] : value.map(x => {
    if (x.type === 'text') return x;
    if (x.type === 'image' && ['image/png','image/jpeg'].includes(x.mimeType) && /^[A-Za-z0-9+/]+=*$/.test(x.data))
      return {type:'image_url',image_url:{url:`data:${x.mimeType};base64,${x.data}`}};
    throw Error('Unsupported message content');
  });
  const content = value => typeof value === 'string' ? value : parts(value);
  const result = [{role:'system', content:getCurrentSystemPrompt(messages)}];
  const provenance=[{kind:'system'}];
  const push=(message,kind)=>{result.push(message);provenance.push({kind});};
  let images=[];
  const flush=()=>{if(images.length){push({role:'user',content:[{type:'text',text:'Task images returned by the preceding tool calls.'},...images]},'tool_images');images=[];}};
  for (const m of messages) {
    if (m.role === 'system') continue;
    if(m.role!=='toolResult')flush();
    if (m.role === 'user') push({role:'user', content:content(m.content)},m.harnessMemory?'harness_memory':m.harnessInboxKind==='observation'?'harness_observation':'human_instruction');
    else if (m.role === 'toolResult') {
      const p=parts(m.content);images.push(...p.filter(x=>x.type==='image_url'));
      push({role:'tool', tool_call_id:m.toolCallId, content:p.filter(x=>x.type==='text').map(x=>x.text).join('\n')},'tool_result');
    }
    else if (m.role === 'assistant') {
      const a = {role:'assistant', content:m.content.filter(x=>x.type==='text').map(x=>x.text).join(''),
        reasoning_content:m.content.filter(x=>x.type==='thinking').map(x=>x.thinking).join('')};
      const calls = m.content.filter(x=>x.type==='toolCall').map(x=>({id:x.id, type:'function', function:{name:x.name, arguments:JSON.stringify(x.arguments)}}));
      if (calls.length) a.tool_calls = calls;
      push(a,'agent_activity');
    } else throw Error('Unknown conversation role');
  }
  flush();
  return {messages:result, tools:getCurrentTools(messages).map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),...(includeProvenance?{provenance}:{})};
}

export function groups(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'toolResult') {
      const last = result.at(-1);
      if (!last || last[0].role !== 'assistant') throw Error('Orphan tool response');
      last.push(m);
    } else result.push([m]);
  }
  for (const group of result) {
    if (group[0].role !== 'assistant') continue;
    const ids = (group[0].content || []).filter(x=>x.type==='toolCall').map(x=>x.id);
    const answered = group.slice(1).map(m=>m.toolCallId);
    if (new Set(ids).size !== ids.length || ids.length !== answered.length || ids.some(id=>!answered.includes(id))) throw Error('Incomplete or duplicate tool-call group');
  }
  return result;
}

export class ContextManager {
 constructor(store,config){this.store=store;this.config=config;this.forceCompact=false;}
 limits(){
  const c=this.config,margin=c.safetyTokens??2048;
  const cap=c.contextTokens-c.generationTokens-margin;
  const soft=c.compactSoftTokens??Math.min(c.promptTokens,40960,cap);
  // Retain validation of historical config fields for explicit migrations only.
  // A historical compactHardTokens value no longer caps normal generations.
  const hard=c.compactHardTokens??null;
  if(![c.contextTokens,c.generationTokens,margin,soft].every(Number.isInteger)||margin<0||cap<512||soft<256||soft>c.contextTokens-margin||(hard!==null&&(!Number.isInteger(hard)||hard<=soft||hard>c.contextTokens-margin)))throw Error('Invalid compact token allocation');
  for(const [key,value] of [['compactTailGroups',c.compactTailGroups??2]])if(!Number.isInteger(value)||value<0||value>100)throw Error('Invalid '+key);
  if(!Number.isInteger(c.compactTokens??4096)||(c.compactTokens??4096)<256||(c.compactTokens??4096)>=c.contextTokens-margin)throw Error('Invalid compactTokens');
  return {margin,cap,soft,hard};
 }
 checkpoint(){
  const checkpoint=this.store.events.filter(e=>e.type==='compact_commit').at(-1)?.data.checkpoint;
  if(!checkpoint)return checkpoint;
  const raw=this.store.events.filter(e=>e.type==='message').map(e=>e.data).filter(m=>m.role!=='system'&&!m.harnessMemory&&(m.role!=='assistant'||!['error','aborted'].includes(m.stopReason))).slice(0,checkpoint.cut);
  if(hash(JSON.stringify(raw))!==checkpoint.prefixHash)return checkpoint;
  return {...checkpoint,prefixHash:hash(JSON.stringify(presentMessages(this.store,{config:this.config.sandbox},raw)))};
 }
 ordinary(messages){return messages.filter(m=>m.role!=='system'&&!m.harnessMemory);}
 // Retain full originals on disk, bound only the tool presentation under pressure.
 bounded(messages){return messages.map(m=>{
  if(m.role!=='toolResult')return m;
  const text=typeof m.content==='string'?m.content:m.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  if(text.length<=2000)return m;
  return {...m,content:[{type:'text',text:boundedText(this.store,{config:this.config.sandbox},text,m.toolCallId,1600)},...(Array.isArray(m.content)?m.content.filter(x=>x.type==='image'):[])]};
 });}
 assemble(system,ordinary,checkpoint){
  if(!checkpoint)return [system,...ordinary].filter(Boolean);
  if(checkpoint.cut>ordinary.length||hash(JSON.stringify(ordinary.slice(0,checkpoint.cut)))!==checkpoint.prefixHash)throw Error('Compact checkpoint history identity mismatch');
  const retired=new Set(this.store.events.filter(e=>e.type==='operator_note_retired').map(e=>e.data.id));
  const delivered=new Set(this.store.events.filter(e=>e.type==='inbox_delivered').map(e=>e.data.id));
  const priorHumans=ordinary.slice(1,checkpoint.cut).filter(m=>m.role==='user'&&((m.harnessInboxId&&!delivered.has(m.harnessInboxId))||(m.harnessInboxKind!=='observation'&&!retired.has(m.harnessInboxId))));
  return [system,ordinary[0],...priorHumans,{role:'user',harnessMemory:true,content:'Recovery view; original task/human instructions remain authoritative. Continue the specific current_work and next_step; retrieve exact evidence or reread referenced files when needed.\n'+JSON.stringify(checkpoint.summary),timestamp:checkpoint.time},...ordinary.slice(checkpoint.cut)].filter(Boolean);
 }
 async build(messages,counter,complete){
  const system=getCurrentSystemMessage(messages),ordinary=this.ordinary(messages);
  if(ordinary[0]?.role!=='user')throw Error('Missing original task');groups(ordinary);
  if(ordinary.at(-1)?.harnessTruncated)this.forceCompact=true;
  const continuation=ordinary.at(-1)?.harnessTruncationContinuationFor;
  if(Number.isInteger(continuation)&&(this.store.events.findLast(e=>e.type==='compact_commit')?.seq??-1)<continuation)this.forceCompact=true;
  const {margin,cap,soft}=this.limits();
  let checkpoint=this.checkpoint(),candidate=this.config.mode==='baseline'?messages:this.assemble(system,ordinary,checkpoint);
  let tokens=await counter(wire(candidate));
  if(!Number.isInteger(tokens)||tokens<1)throw Error('Invalid native token count');
  // Never rewrite an already sent tool result/thinking prefix to make room.
  // Compact selects a complete prefix and retains the remaining groups verbatim.
  if(this.config.mode==='baseline'){
   if(tokens>cap||tokens>this.config.promptTokens)throw Error('Baseline context budget exhausted');
  }else if(this.forceCompact||tokens>=soft||tokens>cap){
   if(!complete)throw Error('Compact model callback required; history retained');
   checkpoint=await this.compact(system,ordinary,counter,complete);
   this.forceCompact=false;candidate=this.assemble(system,ordinary,checkpoint);tokens=await counter(wire(candidate));
  }
  if(!Number.isInteger(tokens)||tokens<1||tokens+this.config.generationTokens+margin>this.config.contextTokens)throw Error('Exact context reserve exceeded; history retained');
  // Count the actual full-prefix Compact envelope, including the recovery footer
  // and schema. Reserve its complete output allowance plus a small framing
  // allowance for a truncated assistant and its continuation observation.
  // This is physical-capacity admission, independent of the fixed soft line.
  const output=this.config.compactTokens??4096,continuationReserve=256;
  const plan=this.compactInput(system,ordinary,checkpoint);
  const compactInputTokens=await counter(plan.request,{kind:'compact',maxTokens:output});
  if(!Number.isInteger(compactInputTokens)||compactInputTokens<1)throw Error('Invalid native compact token count');
  const maxTokens=this.config.mode==='baseline'?this.config.generationTokens:Math.min(this.config.generationTokens,this.config.contextTokens-output-margin-compactInputTokens-continuationReserve);
  if(maxTokens<1)throw Error('Full-prefix Compact capacity exhausted before generation; history retained');
  this.store.append('context_budget',{input_tokens:tokens,output_tokens:this.config.generationTokens,safety_tokens:margin,engine_context:this.config.contextTokens,hard_limit:null,soft_limit:soft,compact_input_tokens:compactInputTokens,compact_output_tokens:output,continuation_reserve_tokens:continuationReserve,max_tokens:maxTokens,removed_groups:checkpoint?.cut-1||0,all_history_retained:true});
  return {messages:candidate,tokens,removed:checkpoint?.cut-1||0,maxTokens,capacityLimited:maxTokens<this.config.generationTokens};
 }
 compactInput(system,ordinary,previous){
  const oldCut=previous?.cut??1,all=groups(ordinary.slice(oldCut));
  const lastAssistant=all.findLastIndex(group=>group[0].role==='assistant');
  const hasUnreadTools=lastAssistant>=0&&all[lastAssistant][0].content?.some(x=>x.type==='toolCall');
  const minimumTail=hasUnreadTools?all.length-lastAssistant:0;
  const keep=Math.max(minimumTail,Math.min(this.config.compactTailGroups??2,Math.max(0,all.length-1)));
  const cut=ordinary.length-all.slice(all.length-keep).flat().length;
  const cutInput=wire(this.assemble(system,ordinary.slice(0,cut),previous));
  const {provenance,...prefix}=wire(this.assemble(system,ordinary,previous),{includeProvenance:true});
  const payload={covered_messages:{from:oldCut,to:cut},previous_compact_in_prefix:Boolean(previous),retained_recent_groups:keep,
   retained_recent_message_indexes:provenance.flatMap((_,i)=>i>=cutInput.messages.length?[i]:[]),retained_human_instructions:[],
   actual_human_message_indexes:provenance.flatMap((p,i)=>p.kind==='human_instruction'?[i]:[]),
   non_human_user_message_indexes:provenance.flatMap((p,i)=>['harness_memory','harness_observation','tool_images'].includes(p.kind)?[i]:[])};
  return {cut,keep,all,oldCut,prefix,request:{...prefix,messages:[...prefix.messages,{role:'user',content:compactPrompt(previous)+'\n\n'+JSON.stringify(payload)}],tool_choice:'none'}};
 }
 async compact(system,ordinary,counter,complete){
  const start=this.store.append('compact_start',{mode:'single_pass'});let status='failed';
  try {
  const previous=this.checkpoint(),oldCut=previous?.cut??1;
  const all=groups(ordinary.slice(oldCut));
  if(!all.length)throw Error('No new safe history for compact');
  const {margin}=this.limits(),output=this.config.compactTokens??4096;
  const cap=this.config.contextTokens-output-margin;
  const {cut,keep,request,prefix}=this.compactInput(system,ordinary,previous);
  const inputTokens=await counter(request,{kind:'compact',maxTokens:output});
  if(!Number.isInteger(inputTokens)||inputTokens<1)throw Error('Invalid native compact token count');
  if(keep>=all.length||cut<=oldCut||inputTokens>cap){
   this.store.append('compact_capacity_exceeded',{input_tokens:inputTokens,output_tokens:output,safety_tokens:margin,engine_context:this.config.contextTokens,full_prefix_messages:prefix.messages.length,history_retained:true});
   throw Error('Full-prefix Compact exceeds exact capacity; no history trimmed; history retained');
  }
  const last=ordinary[cut-1];
  const boundary=this.store.events.filter(e=>e.type==='message'&&(hash(JSON.stringify(e.data))===hash(JSON.stringify(last))||hash(JSON.stringify(presentMessages(this.store,{config:this.config.sandbox},[e.data])[0]))===hash(JSON.stringify(last)))).at(-1)?.seq;
  if(boundary===undefined)throw Error('Compact boundary must be persisted');
  // ONE generation; count includes the actual non-thinking schema/tool request.
  const summary=validateCompact(await complete(request,{kind:'compact',maxTokens:output}));
  const checkpoint={cut,prefixHash:hash(JSON.stringify(ordinary.slice(0,cut))),summary,time:Date.now(),boundary_event_seq:boundary};
  let restored=this.assemble(system,ordinary,checkpoint),restoredTokens=await counter(wire(restored));

  if(restoredTokens+this.config.generationTokens+margin>this.config.contextTokens||restoredTokens>=this.limits().soft)throw Error('Compact did not restore sufficient context headroom');
  // A single journal event commits the validated checkpoint; failures above keep the previous one.
  this.store.append('compact_commit',{checkpoint,restored_tokens:restoredTokens,mode:'single_pass_prefix_v3',prompt_kind:previous?'update':'initial',input_tokens:inputTokens,prefix_messages:prefix.messages.length,tools_retained:prefix.tools.length,covered_messages:cut-oldCut,model_calls:1});
  this.store.snapshot('compact-checkpoint',checkpoint);
  status='committed';return checkpoint;
  } finally {this.store.append('compact_end',{start_seq:start.seq,status,elapsed_ms:Math.max(0,Date.now()-start.time)});}
 }
}
