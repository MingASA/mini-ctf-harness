import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {getCurrentSystemMessage} from '@earendil-works/pi-ai';
import {bodySettings,settingsHash} from './generation-controls.mjs';
import {ContextManager, wire} from './context.mjs';
import {COMPACT_SCHEMA} from './compact-prompts.mjs';
import {hash} from './store.mjs';
import {LocalModelRecovery} from './local-model.mjs';

export const DEFAULT_GUARD = process.env.MINI_CTF_PROCESS_GUARD;
export function assertExperimentIdle(processFile = DEFAULT_GUARD) {
  if (!processFile||!fs.existsSync(processFile)) return;
  const p = JSON.parse(fs.readFileSync(processFile,'utf8').replace(/^\uFEFF/,''));
  if (!Number.isInteger(p.pid) || p.pid < 1) throw Error('Invalid active experiment process receipt');
  const proc = `/proc/${p.pid}/stat`;
  if (fs.existsSync(proc) && fs.readFileSync(proc,'utf8').split(') ').at(-1)[0] !== 'Z') throw Error(`Current experiment is running (PID ${p.pid}); no model or metadata request permitted`);
}

export class NativeClient {
  constructor(config, store, {guard = assertExperimentIdle, fetchFn = fetch, onAccepted = ()=>{},localRecovery,operatorSignal,requestSignal,onAuxiliary=()=>{}} = {}) {
    const url = new URL(config.baseUrl);
    if (!['127.0.0.1','[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw Error('Local model origin must be an explicit loopback HTTP origin');
    this.config=config; this.store=store; this.guard=guard; this.fetchFn=fetchFn; this.origin=url.origin;
    this.context=new ContextManager(store,config);
    this.onAccepted=onAccepted;this.operatorSignal=operatorSignal;this.requestSignal=requestSignal;this.onAuxiliary=onAuxiliary;
    this.localRecovery=localRecovery??(config.localRecovery?new LocalModelRecovery(config.localRecovery,store):null);
  }
  body(input,{kind,maxTokens}={}) {
    const events=this.store.events??[];
    const body={model:this.config.model,...input,temperature:this.config.thinking===false?(this.config.nonThinkingTemperature??0.7):(this.config.temperature??1),seed:this.config.seed ?? 42,
      top_p:this.config.thinking===false?0.80:0.95,top_k:20,min_p:0,presence_penalty:0,repeat_penalty:1,parallel_tool_calls:true,
      chat_template_kwargs:{enable_thinking:this.config.thinking!==false,reasoning_effort:this.config.reasoningEffort??'medium'},reasoning_budget_tokens:this.config.reasoningTokens,
      cache_prompt:!events.some(e=>e.type==='kv_invalidated'&&!events.some(x=>x.type==='model_accepted'&&x.seq>e.seq)),max_tokens:this.config.generationTokens};
    if(kind==='compact')Object.assign(body,{
      tool_choice:'none',parallel_tool_calls:false,
      temperature:this.config.compactThinking?(this.config.temperature??1):(this.config.compactTemperature??0.7),
      top_p:this.config.compactThinking?0.95:0.80,top_k:20,
      chat_template_kwargs:{enable_thinking:this.config.compactThinking??false,reasoning_effort:this.config.compactReasoningEffort??this.config.reasoningEffort??'medium'},
      reasoning_budget_tokens:this.config.compactThinking?(this.config.compactReasoningTokens??4096):this.config.reasoningTokens,
      response_format:{type:'json_schema',json_schema:{name:'compact_checkpoint',strict:true,schema:COMPACT_SCHEMA}},
      max_tokens:Math.min(maxTokens??this.config.compactTokens??this.config.generationTokens,this.config.generationTokens)
    });
    if(Number.isInteger(this.config.nativeSlot))body.id_slot=this.config.nativeSlot;
    return body;
  }
  async request(route, body, signal, activeRequestId) {
    this.guard({activeRequestId});
    if(this.localRecovery)await this.localRecovery.prepare(body,signal);
    for(let attempt=1;attempt<=2;attempt++){
      try{
        const response=await this.fetchFn(this.origin+route,{method:'POST',redirect:'error',signal,
          headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        if(!response.ok){const error=Error(`Local model HTTP ${response.status}`);error.retryable=response.status>=500;throw error;}
        return response;
      }catch(error){
        if(!this.localRecovery||attempt===2||signal?.aborted||error.retryable===false||/^Local model HTTP [34]/.test(error.message))throw error;
        this.store.append('native_request_retry',{route,requestId:activeRequestId,attempt,error_kind:error.name,task_tools_replayed:false});
        await this.localRecovery.prepare(body,signal,{force:true});
      }
    }
  }
  async count(input, signal, options) {
    const route='/v1/chat/completions/input_tokens',body=this.body(input,options);
    for(let attempt=1;attempt<=2;attempt++){
      signal?.throwIfAborted();
      try {
        const data=await (await this.request(route,body,signal)).json();
        return data.input_tokens;
      } catch(error) {
        // This endpoint only counts tokens: it cannot generate or execute tools.
        // Retry one proven connection timeout, with the same body/solve signal.
        // Generation requests and all other failures still require explicit review.
        if(attempt===2||signal?.aborted||error.cause?.code!=='UND_ERR_CONNECT_TIMEOUT')throw error;
        this.store.append('native_metadata_retry',{route,attempt:2,cause_code:error.cause.code,delay_ms:100});
        await delay(100,undefined,{signal});
      }
    }
  }
  async checkSettingsPrefix(input,signal){
    const before=this.store.events.findLast(e=>e.type==='model_request'&&!e.data.kind)?.data.body;
    if(!before)return;
    const after=this.body(input),from=bodySettings(before),to=bodySettings(after);
    if(settingsHash(from)===settingsHash(to))return;
    const history=hash(JSON.stringify(input));
    if(this.store.events.some(e=>e.type==='generation_prefix_check'&&e.data.history===history&&e.data.from_sha===settingsHash(from)&&e.data.to_sha===settingsHash(to)))return;
    let result={status:'unknown',policy:'native_common_prefix_revalidation'};
    try{
      const ids=async body=>{
        this.guard();signal?.throwIfAborted();
        const call=async(route,value)=>{
          const response=await this.fetchFn(this.origin+route,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify(value)});
          if(!response.ok)throw Error('Template metadata HTTP '+response.status);return response.json();
        };
        const rendered=await call('/apply-template',body);
        if(typeof rendered.prompt!=='string')throw Error('Template did not return a text prompt');
        const data=await call('/tokenize',{content:rendered.prompt,add_special:true,parse_special:true});
        if(!Array.isArray(data.tokens)||!data.tokens.length||data.tokens.some(t=>!Number.isInteger(t)))throw Error('Invalid template tokens');
        return data.tokens;
      };
      const a=await ids({...after,chat_template_kwargs:before.chat_template_kwargs,reasoning_budget_tokens:before.reasoning_budget_tokens}),b=await ids(after);
      let common=0;while(common<Math.min(a.length,b.length)&&a[common]===b[common])common++;
      result={...result,status:common===a.length&&common===b.length?'unchanged':'changed',before_tokens:a.length,after_tokens:b.length,common_tokens:common,before_sha:hash(JSON.stringify(a)),after_sha:hash(JSON.stringify(b))};
    }catch(error){if(signal?.aborted)throw error;result.error=error.message;}
    this.store.append('generation_prefix_check',{...result,from,to,from_sha:settingsHash(from),to_sha:settingsHash(to),history,model_reloaded:false,kv_erased:false});
  }
  async compactNow(messages,signal){
    const ordinary=this.context.ordinary(messages);if(ordinary.length<2)return {status:'no_history'};
    const plan=this.context.compactInput(getCurrentSystemMessage(messages),ordinary,this.context.checkpoint());if(plan.cut<=plan.oldCut)return {status:'no_new_history'};
    const checkpoint=await this.context.compact(getCurrentSystemMessage(messages),ordinary,(input,opts)=>this.count(input,signal,opts),(input,opts)=>this.complete(input,{...opts,signal}));
    this.context.forceCompact=false;return {status:'committed',checkpoint};
  }
  async complete(input,{kind,maxTokens,signal}={}) {
    this.guard();
    const body={...this.body(input,{kind,maxTokens}),stream:true,stream_options:{include_usage:true}};
    if(!Number.isInteger(body.max_tokens)||body.max_tokens<1)throw Error('Invalid auxiliary output reserve');
    // Count the very same template, medium effort, retained tools, and Compact-only
    // non-thinking flag that will be sent to generation.
    const tokens=await this.count(input,signal,{kind,maxTokens});
    if(!Number.isInteger(tokens)||tokens<1||tokens+body.max_tokens+(this.config.safetyTokens??2048)>this.config.contextTokens)throw Error('Auxiliary exact token reserve exceeded');
    const requestId=this.store.events.filter(e=>e.type==='model_request').length+1;
    this.store.append('model_request',{requestId,kind,prompt_tokens:tokens,body,inboxIds:[]});
    // Long prefill plus generation can exceed fetch's nonstream response-header
    // timeout. SSE sends headers immediately and preserves progress on disk.
    const response=await this.request('/v1/chat/completions',body,signal,requestId);
    this.store.append('model_accepted',{requestId,kind,inboxIds:[]});
    const rawFile=path.join(this.store.root,`request-${requestId}.sse`),decoder=new TextDecoder();
    let content='',reasoning='',buffer='',finish=null,usage=null,done=false,hasTools=false,reasoningChars=0;
    const line=value=>{
      if(!value.startsWith('data:'))return;
      const payload=value.slice(5).trim();if(payload==='[DONE]'){done=true;return;}
      const chunk=JSON.parse(payload);if(chunk.error)throw Error('Native auxiliary stream error');
      if(chunk.usage)usage=chunk.usage;
      const choice=chunk.choices?.[0];if(!choice)return;
      if(choice.finish_reason)finish=choice.finish_reason;
      if(choice.delta?.tool_calls?.length)hasTools=true;
      if(typeof choice.delta?.reasoning_content==='string'){reasoning+=choice.delta.reasoning_content;reasoningChars=reasoning.length;}
      if(typeof choice.delta?.content==='string')content+=choice.delta.content;
      this.onAuxiliary({kind,requestId,content,reasoning});
    };
    try {
    for await(const chunk of response.body){
      fs.appendFileSync(rawFile,chunk);buffer+=decoder.decode(chunk,{stream:true});
      let index;while((index=buffer.indexOf('\n'))>=0){line(buffer.slice(0,index).trimEnd());buffer=buffer.slice(index+1);}
    }
    buffer+=decoder.decode();if(buffer.trim())line(buffer.trimEnd());signal?.throwIfAborted();
    }catch(error){
      const ref=this.store.put({requestId,kind,content,reasoning,unparsed_tail:buffer,raw_file:rawFile,usage,interrupted:Boolean(signal?.aborted)},'model:'+kind+'_partial');
      this.store.append('model_auxiliary_interrupted',{requestId,kind,evidence_id:ref.id,raw_file:rawFile});throw error;
    }
    this.store.put({content,finish,usage,done,hasTools,reasoning_chars:reasoningChars,raw_file:rawFile},'model:'+kind);
    if(usage&&Number.isInteger(usage.completion_tokens)&&usage.completion_tokens>=0&&usage.completion_tokens<=body.max_tokens)this.store.append('model_usage',{requestId,completion_tokens:usage.completion_tokens});
    if(!done||!usage||usage.prompt_tokens!==tokens||!Number.isInteger(usage.completion_tokens)||usage.completion_tokens<0||usage.completion_tokens>body.max_tokens||finish!=='stop'||hasTools||!content||(kind==='compact'&&!body.chat_template_kwargs.enable_thinking&&reasoningChars))throw Error('Invalid or truncated '+kind+' response: finish='+finish+', expected_input='+tokens+', actual_input='+usage?.prompt_tokens+', output='+usage?.completion_tokens+', limit='+body.max_tokens+', done='+done+', reasoning_chars='+reasoningChars);
    this.store.append('model_auxiliary_response',{requestId,kind,content,native_usage:usage,reasoning_chars:reasoningChars});
    return content;
  }
  async preflight(signal) {
    this.guard();
    if(this.localRecovery)await this.localRecovery.prepare(null,signal,{force:true});
    if(this.config.verifyModel){const response=await this.fetchFn(this.origin+'/v1/models',{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});if(!response.ok||!(await response.json()).data?.some(m=>m.id===this.config.model))throw Error('Backend is serving a different model');}
    for (const route of ['/health','/slots','/props']) {
      this.guard();
      const response=await this.fetchFn(this.origin+route,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
      if(!response.ok) throw Error('Native service preflight failed: '+route);
      let data=await response.json();
      if(route==='/slots'&&Array.isArray(data)&&data.some(x=>x.is_processing)){
        const last=this.store.events.findLast(e=>e.type==='model_request'),ownedAbort=last&&this.store.events.some(e=>['model_interrupted','model_auxiliary_interrupted'].includes(e.type)&&e.data.requestId===last.data.requestId);
        const deadline=Date.now()+5000;
        while(ownedAbort&&data.some(x=>x.is_processing)&&Date.now()<deadline){
          signal?.throwIfAborted();this.guard();await delay(100,undefined,{signal});
          const retry=await this.fetchFn(this.origin+route,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1000)]):AbortSignal.timeout(1000)});
          if(!retry.ok)throw Error('Native idle check failed');data=await retry.json();if(!Array.isArray(data))throw Error('Invalid native slots');
        }
      }
      if(route==='/health' && data.status!=='ok') throw Error('Native model is not ready');
      if(route==='/slots' && (!Array.isArray(data) || data.some(x=>x.is_processing))) throw Error('Native model is already processing another request');
      if(route==='/props' && data.default_generation_settings?.n_ctx!==this.config.contextTokens) throw Error('Native engine context does not match frozen run configuration');
      this.store.append('native_preflight',{route,checked_at:Date.now(),
        context_tokens:route==='/props'?data.default_generation_settings.n_ctx:undefined,
        slots:route==='/slots'?data.map(s=>({id:s.id,is_processing:s.is_processing,n_ctx:s.n_ctx})):undefined});
    }
  }
  stream = (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const message = {role:'assistant',content:[],api:'openai-completions',provider:'local-qwen',model:model.id,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:'error',timestamp:Date.now()};
    (async () => {
      const signals=[options.signal,this.operatorSignal,this.requestSignal].filter(Boolean),signal=signals.length?AbortSignal.any(signals):undefined;
      let requestId=null,body=null,rawFile=null,calls=new Map(),buffer='',usage=null;
      try {
        const built=await this.context.build(context.messages,(input,opts)=>this.count(input,signal,opts),(input,opts)=>this.complete(input,{...opts,signal}));
        body={...this.body(built.input || wire(built.messages)),max_tokens:built.maxTokens??this.config.generationTokens,stream:true,stream_options:{include_usage:true}};
        await this.checkSettingsPrefix(built.input||wire(built.messages),signal);
        requestId=this.store.events.filter(e=>e.type==='model_request').length+1;
        const inboxIds=built.inboxIds || built.messages.filter(m=>m.harnessInboxId).map(m=>m.harnessInboxId);
        this.store.append('model_request',{requestId,prompt_tokens:built.tokens,body,inboxIds});
        rawFile=path.join(this.store.root,`request-${requestId}.sse`);
        const response=await this.request('/v1/chat/completions',body,signal,requestId);
        this.store.append('model_accepted',{requestId,inboxIds});
        await this.onAccepted({requestId,inboxIds});
        stream.push({type:'start',partial:message});
        let text='',thinking='',finish=null,done=false;
        const decoder=new TextDecoder();
        const indexes={};
        const deltaPart=(kind,delta)=>{
          if(!delta)return;
          if(indexes[kind]===undefined){
            indexes[kind]=message.content.length;
            message.content.push({type:kind,[kind]:''});
            stream.push({type:kind+'_start',contentIndex:indexes[kind],partial:message});
          }
          const index=indexes[kind];message.content[index][kind]+=delta;
          stream.push({type:kind+'_delta',contentIndex:index,delta,partial:message});
        };
        const line = value => {
          if (!value.startsWith('data:')) return;
          const payload=value.slice(5).trim();
          if (payload==='[DONE]') {done=true;return;}
          const chunk=JSON.parse(payload); if(chunk.error) throw Error('Native stream error');
          if(chunk.usage) usage=chunk.usage;
          const c=chunk.choices?.[0]; if(!c) return;
          if(c.finish_reason) finish=c.finish_reason;
          const d=c.delta || {};text+=d.content || '';thinking+=d.reasoning_content || '';
          deltaPart('thinking',d.reasoning_content);deltaPart('text',d.content);
          for(const t of d.tool_calls || []) {
            let prior=calls.get(t.index);
            if(!prior){
              prior={id:'',name:'',arguments:'',contentIndex:message.content.length};
              message.content.push({type:'toolCall',id:`request-${requestId}:pending-${t.index}`,name:'',arguments:{}});
              stream.push({type:'toolcall_start',contentIndex:prior.contentIndex,partial:message});
            }
            if(t.id) prior.id=t.id;
            prior.name+=t.function?.name || ''; prior.arguments+=t.function?.arguments || '';calls.set(t.index,prior);
            Object.assign(message.content[prior.contentIndex],{id:`request-${requestId}:${prior.id}`,name:prior.name});
            stream.push({type:'toolcall_delta',contentIndex:prior.contentIndex,delta:t.function?.arguments||'',partial:message});
          }
        };
        for await(const chunk of response.body) {
          fs.appendFileSync(rawFile,chunk);
          buffer+=decoder.decode(chunk,{stream:true});
          let i; while((i=buffer.indexOf('\n'))>=0) {line(buffer.slice(0,i).trimEnd());buffer=buffer.slice(i+1);}
        }
        buffer+=decoder.decode(); if(buffer.trim()) line(buffer.trimEnd());
        signal?.throwIfAborted();
        if(usage && Number.isInteger(usage.completion_tokens) && usage.completion_tokens>=0 && usage.completion_tokens<=body.max_tokens)
          this.store.append('model_usage',{requestId,completion_tokens:usage.completion_tokens});
        if(!done || !finish || !usage || usage.prompt_tokens!==built.tokens || !Number.isInteger(usage.completion_tokens) || usage.completion_tokens<0 || usage.completion_tokens>body.max_tokens) throw Error('Incomplete stream or native token accounting mismatch');
        if(finish==='length'&&built.capacityLimited){
          this.store.append('model_truncated',{requestId,reason:'compact_capacity_limit',partial:structuredClone(message),native_usage:usage});
          this.context.forceCompact=true;
          message.content=message.content.filter(x=>x.type!=='toolCall');
          message.content.push({type:'text',text:'[Generation reached the measured Compact capacity limit. No incomplete tool calls executed. Compact before continuing.]'});
          message.stopReason='stop';message.harnessTruncated=true;
          message.usage={...message.usage,input:usage.prompt_tokens,output:usage.completion_tokens,totalTokens:usage.total_tokens};
          stream.push({type:'done',reason:'stop',message});stream.end();return;
        }
        if(finish==='length'){
          // A truncated response never authorizes a tool call, including calls
          // whose JSON happens to look complete. Keep their raw drafts as
          // evidence, retain the model's prose/thinking and request a fresh call.
          if(calls.size){
            const ref=this.store.put({requestId,executed:false,calls:[...calls.values()].map(({id,name,arguments:args})=>({id,name,arguments:args}))},'model:unexecuted_tool_drafts');
            this.store.append('model_tool_drafts_discarded',{requestId,evidence_id:ref.id,count:calls.size,reason:'generation_output_limit',executed:false});
            message.harnessUnexecutedDrafts=ref.id;
          }
          message.content=message.content.filter(x=>['thinking','text'].includes(x.type));
          if(!message.content.length)message.content.push({type:'text',text:'[The response reached its output limit before completing a tool call. No tool calls were executed.]'});
          for(const [kind,index] of Object.entries(indexes))stream.push({type:kind+'_end',contentIndex:index,content:message.content[index][kind],partial:message});
          message.stopReason='stop';message.harnessOutputTruncated=true;
          message.usage={...message.usage,input:usage.prompt_tokens,output:usage.completion_tokens,totalTokens:usage.total_tokens,
            cacheRead:usage.prompt_tokens_details?.cached_tokens||0};
          this.store.append('model_output_truncated',{requestId,reason:'generation_output_limit',content_sha256:hash(JSON.stringify(message.content)),native_usage:usage});
          stream.push({type:'done',reason:'stop',message});stream.end();return;
        }
        if(!['stop','tool_calls'].includes(finish)) throw Error('Unsupported native finish reason');
        const nativeIds=new Set();
        for(const [,c] of [...calls].sort((a,b)=>a[0]-b[0])) {
          const args=JSON.parse(c.arguments);
          if(!c.id || !c.name || !args || Array.isArray(args) || typeof args!=='object') throw Error('Invalid complete tool call');
          if(nativeIds.has(c.id))throw Error('Duplicate native tool call ID within one response');
          nativeIds.add(c.id);
          // Some local servers restart call numbering on every response.
          Object.assign(message.content[c.contentIndex],{id:`request-${requestId}:${c.id}`,name:c.name,arguments:args});
        }
        if((finish==='tool_calls') !== Boolean(calls.size)) throw Error('Tool-call finish reason mismatch');
        if(!text && !calls.size) throw Error('Empty final response');
        for(const [kind,index] of Object.entries(indexes))stream.push({type:kind+'_end',contentIndex:index,content:message.content[index][kind],partial:message});
        for(const c of calls.values())stream.push({type:'toolcall_end',contentIndex:c.contentIndex,toolCall:message.content[c.contentIndex],partial:message});
        message.stopReason=calls.size?'toolUse':'stop';
        message.usage={...message.usage,input:usage.prompt_tokens,output:usage.completion_tokens,totalTokens:usage.total_tokens,
          cacheRead:usage.prompt_tokens_details?.cached_tokens || 0};
        this.store.append('model_response',{requestId,message,native_usage:usage});
        stream.push({type:'done',reason:message.stopReason,message});stream.end();
      } catch(error) {
        if(this.operatorSignal?.aborted){
          const drafts=[...calls.values()].map(({id,name,arguments:args})=>({id,name,arguments:args}));
          const ref=this.store.put({requestId,message:structuredClone(message),drafts,unparsed_tail:buffer,raw_file:rawFile,native_usage:usage,executed:false},'model:operator_interrupted');
          message.content=message.content.filter(p=>['text','thinking'].includes(p.type));
          if(!message.content.length)message.content.push({type:'text',text:'[Generation interrupted by the operator. No tool drafts from this response were executed.]'});
          message.harnessOperatorInterrupted=true;message.harnessInterruptedEvidence=ref.id;message.stopReason='stop';
          if(usage&&Number.isInteger(usage.completion_tokens)&&usage.completion_tokens>=0&&usage.completion_tokens<=body?.max_tokens){
            if(!this.store.events.some(e=>e.type==='model_usage'&&e.data.requestId===requestId))this.store.append('model_usage',{requestId,completion_tokens:usage.completion_tokens});
            message.usage={...message.usage,input:usage.prompt_tokens,output:usage.completion_tokens,totalTokens:usage.total_tokens};
          }
          this.store.append('model_interrupted',{requestId,evidence_id:ref.id,raw_file:rawFile,tool_drafts:drafts.length,executed:false,usage_known:Boolean(usage)});
          stream.push({type:'done',reason:'stop',message});stream.end();return;
        }
        message.content=[];message.errorMessage=String(error.message);message.stopReason=signal?.aborted?'aborted':'error';
        this.store.append('model_error',{error:message.errorMessage,error_kind:error.name,
          cause_code:typeof error.cause?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.cause.code)?error.cause.code:undefined});
        stream.push({type:'error',reason:message.stopReason,error:message});stream.end();
      }
    })();
    return stream;
  };
}
