import http from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {validateServiceUrl} from '../service-endpoint.mjs';
import {searchIndex,evidence} from './search.mjs';
import {JobStore,REQUEST_ID,requestHash} from './job-store.mjs';

const TERMINAL=new Set(['completed','failed','cancelled']);
export class JobQueue {
  constructor(worker,{concurrency=2,maxJobs=128,timeoutMs=30000,retentionMs=600000,jobDir=null}={}) {
    if (typeof worker!=='function'||!Number.isSafeInteger(concurrency)||concurrency<1||
        !Number.isSafeInteger(maxJobs)||maxJobs<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(retentionMs)||retentionMs<1) throw Error('Invalid queue configuration');
    Object.assign(this,{worker,concurrency,maxJobs,timeoutMs,retentionMs});this.jobs=new Map();this.requests=new Map();this.pending=[];this.active=0;this.closed=false;
    this.storage=jobDir?new JobStore(jobDir):null;
    try {
      for(const record of this.storage?.list()||[]){
        if(record.requestId){if(this.requests.has(record.requestId))throw Error('Duplicate durable request ID');this.requests.set(record.requestId,{jobId:record.jobId,hash:record.requestHash});}
        if(!TERMINAL.has(record.status)){record.status='failed';record.finishedAt=Date.now();record.error={code:'INTERRUPTED',message:'Retrieval service stopped before durable completion; no automatic replay'};this.storage.write(record);}
      }
    }catch(error){this.storage?.close();throw error;}
  }
  commit(job,patch={}) {
    if(this.storageError)throw this.storageError;
    try{this.storage?.write({...job,...patch});}catch(cause){
      const error=Error('Retrieval persistence unavailable');error.code='STORAGE_ERROR';error.cause=cause;this.storageError=error;this.closed=true;
      for(const active of this.jobs.values()){clearTimeout(active.timer);active.controller?.abort(error);}throw error;
    }
    Object.assign(job,patch);
  }
  sweep() {
    const now=Date.now();
    for (const [id,job] of this.jobs) if(TERMINAL.has(job.status)&&now-job.finishedAt>this.retentionMs){this.jobs.delete(id);if(!this.storage&&job.requestId)this.requests.delete(job.requestId);}
  }
  submit(request) {
    if(this.storageError)throw this.storageError;
    if(this.closed)throw Error('Queue is closed');
    this.sweep();
    const requestId=request&&typeof request==='object'?request.requestId:undefined;
    if(requestId!==undefined&&(typeof requestId!=='string'||!REQUEST_ID.test(requestId)))throw Error('Invalid request ID');
    const body=request&&typeof request==='object'&&!Array.isArray(request)?Object.fromEntries(Object.entries(request).filter(([key])=>key!=='requestId')):request;
    const hash=requestHash(body);
    if(requestId&&this.requests.has(requestId)){
      const old=this.requests.get(requestId);if(old.hash!==hash){const error=Error('Request ID already bound to different task or search parameters');error.code='REQUEST_CONFLICT';throw error;}
      return this.status(old.jobId);
    }
    if(this.jobs.size>=this.maxJobs){const error=Error('Retrieval queue is full');error.code='QUEUE_FULL';throw error;}
    const job={jobId:randomUUID(),status:'queued',createdAt:Date.now(),request:body,requestHash:hash,...(requestId?{requestId}:{}),controller:new AbortController()};
    this.commit(job);
    if(requestId)this.requests.set(requestId,{jobId:job.jobId,hash});
    // Node timers overflow above 2^31-1 ms; rearm long deadlines instead of truncating them.
    const deadline=job.createdAt+this.timeoutMs;
    const expire=()=>{
      const remaining=deadline-Date.now();
      if(remaining>0){job.timer=setTimeout(expire,Math.min(remaining,2147483647));job.timer.unref?.();return;}
      try{this.terminate(job,'failed',{code:'TIMEOUT',message:'Retrieval deadline exceeded'});}catch{}
    };
    expire();
    this.jobs.set(job.jobId,job);this.pending.push(job.jobId);queueMicrotask(()=>this.pump());return this.status(job.jobId);
  }
  terminate(job,status,error) {
    if(TERMINAL.has(job.status))return;
    this.commit(job,{status,error,finishedAt:Date.now()});clearTimeout(job.timer);job.controller?.abort(Error(error.message));
    queueMicrotask(()=>this.pump());
  }
  pump() {
    if(this.closed)return;
    while(this.active<this.concurrency&&this.pending.length){
      const job=this.jobs.get(this.pending.shift());if(!job||job.status!=='queued')continue;
      try{this.commit(job,{status:'running',startedAt:Date.now()});}catch{return;}this.active++;
      let abortListener;
      const cancelled=new Promise((_,reject)=>{abortListener=()=>reject(job.controller.signal.reason);job.controller.signal.addEventListener('abort',abortListener,{once:true});});
      Promise.race([Promise.resolve().then(()=>this.worker(job.request,{signal:job.controller.signal})),cancelled])
        .then(result=>{if(job.status==='running'&&!this.storageError)this.commit(job,{result,status:'completed',finishedAt:Date.now()});})
        .catch(error=>{if(job.status==='running'&&!this.storageError){try{this.commit(job,{status:'failed',finishedAt:Date.now(),error:{code:error.code||'SEARCH_FAILED',message:'Retrieval failed; inspect the service configuration'}});}catch{}}})
        .finally(()=>{clearTimeout(job.timer);job.controller.signal.removeEventListener('abort',abortListener);this.active--;this.pump();});
    }
  }
  get(jobId) {
    if(this.storageError)throw this.storageError;
    this.sweep();const job=this.jobs.get(jobId)||this.storage?.read(jobId);
    if(!job){const error=Error('Unknown or expired retrieval job');error.code='NOT_FOUND';throw error;}return job;
  }
  status(jobId) {
    const job=this.get(jobId);
    return {jobId:job.jobId,status:job.status,...(job.requestId?{requestId:job.requestId}:{}),...(job.request?.taskId?{taskId:job.request.taskId}:{}),createdAt:job.createdAt,...(job.startedAt?{startedAt:job.startedAt}:{}),
      ...(job.finishedAt?{finishedAt:job.finishedAt}:{}),queuePosition:job.status==='queued'?this.pending.filter(id=>this.jobs.get(id)?.status==='queued').indexOf(jobId)+1:null,
      ...(job.error?{error:job.error}:{})};
  }
  result(jobId) {const job=this.get(jobId);return {...this.status(jobId),...(job.status==='completed'?{result:job.result}:{})};}
  cancel(jobId) {const job=this.get(jobId);this.terminate(job,'cancelled',{code:'CANCELLED',message:'Retrieval cancelled'});return this.status(jobId);}
  close(){if(this.released)return;this.closed=true;try{for(const job of this.jobs.values())this.terminate(job,'cancelled',{code:'SHUTDOWN',message:'Service shutdown'});}finally{this.storage?.close();this.released=true;}}
}

function validRequest(body) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['query','topK','mode','rerank','candidateCount','requestId','taskId'].includes(k))||
    (body.requestId!==undefined&&(typeof body.requestId!=='string'||!REQUEST_ID.test(body.requestId)))||
    (body.taskId!==undefined&&(typeof body.taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(body.taskId)))||
    typeof body.query!=='string'||!body.query.trim()||body.query.length>4096||
    (body.topK!==undefined&&(!Number.isInteger(body.topK)||body.topK<1||body.topK>50))||
    (body.mode!==undefined&&!['keyword','bm25','hybrid'].includes(body.mode))||
    (body.rerank!==undefined&&typeof body.rerank!=='boolean')||
    (body.candidateCount!==undefined&&(!Number.isInteger(body.candidateCount)||body.candidateCount<(body.topK||5)||body.candidateCount>500))) throw Error('Invalid search request');
  return {query:body.query,topK:body.topK??5,mode:body.mode??'bm25',rerank:body.rerank??false,candidateCount:body.candidateCount??100,...(body.taskId!==undefined?{taskId:body.taskId}:{}),...(body.requestId!==undefined?{requestId:body.requestId}:{})};
}
async function readBody(request) {
  const parts=[];let bytes=0;
  for await(const part of request){bytes+=part.length;if(bytes>32768)throw Error('Request body too large');parts.push(part);}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function authorized(header,token){if(!token)return true;const supplied=Buffer.from(header||'');const expected=Buffer.from('Bearer '+token);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);}
export function createRagServer({index,embedding=null,reranker=null,host='127.0.0.1',token=null,jobDir=null,queueOptions={},search=searchIndex}={}) {
  const hostText=host.includes(':')?'['+host+']':host;
  validateServiceUrl('http://'+hostText+':1');
  if(!['127.0.0.1','::1','localhost'].includes(host)&&(!token||token.length<16))throw Error('LAN service binding requires a token of at least 16 characters');
  const queue=new JobQueue((request,{signal})=>search(index,request,{embedding,reranker,signal}),{...queueOptions,...(jobDir?{jobDir}:{})});
  const server=http.createServer(async(request,response)=>{
    response.setHeader('content-type','application/json');response.setHeader('cache-control','no-store');
    const send=(code,data)=>{response.writeHead(code);response.end(JSON.stringify(data));};
    if(!authorized(request.headers.authorization,token)){send(401,{error:'Unauthorized'});return;}
    try{
      const pathname=new URL(request.url,'http://localhost').pathname;
      if(request.method==='GET'&&pathname==='/health'){send(200,{status:'ok',indexVersion:index.indexVersion,documents:index.documents.length,chunks:index.chunks.length,active:queue.active,queued:queue.pending.filter(id=>queue.jobs.get(id)?.status==='queued').length});return;}
      if(request.method==='POST'&&pathname==='/v1/search/jobs'){send(202,queue.submit(validRequest(await readBody(request))));return;}
      const jobMatch=pathname.match(/^\/v1\/search\/jobs\/([a-f0-9-]{36})(\/result)?$/);
      if(jobMatch){
        if(request.method==='GET'){const value=jobMatch[2]?queue.result(jobMatch[1]):queue.status(jobMatch[1]);send(200,value);return;}
        if(request.method==='DELETE'&&!jobMatch[2]){send(200,queue.cancel(jobMatch[1]));return;}
      }
      const evidenceMatch=pathname.match(/^\/v1\/evidence\/([^/]+)$/);
      if(request.method==='GET'&&evidenceMatch){send(200,evidence(index,decodeURIComponent(evidenceMatch[1])));return;}
      send(404,{error:'Unknown endpoint'});
    }catch(error){send(error.code==='QUEUE_FULL'?429:error.code==='NOT_FOUND'?404:error.code==='REQUEST_CONFLICT'?409:error.code==='STORAGE_ERROR'?503:400,{error:error.code||'INVALID_REQUEST'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>queue.close());
  return {server,queue,host};
}
