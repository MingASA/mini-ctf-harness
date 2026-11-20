import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {JobQueue,createRagServer} from '../src/rag/service.mjs';
import {RagClient} from '../src/rag/client.mjs';
import {EmbeddingAdapter,RerankAdapter,requestJson} from '../src/rag/adapters.mjs';
import {buildIndex} from '../src/rag/index.mjs';
const example=new URL('../examples/rag-retrieval/manifest.json',import.meta.url).pathname;
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}));return 'http://127.0.0.1:'+s.address().port;}
async function until(check){for(let i=0;i<100;i++){const value=await check();if(value)return value;await delay(5);}throw Error('Timed out waiting for test state');}
test('queue accepts operator settings beyond former ceilings and preserves concurrency',async t=>{
 let started=0;const queue=new JobQueue(()=>{started++;return new Promise(()=>{});},{concurrency:32,maxJobs:10000,timeoutMs:600000});
 t.after(()=>queue.close());const jobs=Array.from({length:33},()=>queue.submit({}));
 await until(()=>started===32);assert.equal(queue.status(jobs[32].jobId).status,'queued');
});
test('long deadlines do not overflow Node timers and a smaller configured queue still applies',async t=>{
 const queue=new JobQueue(()=>new Promise(()=>{}),{concurrency:32,maxJobs:1,timeoutMs:2147483648});
 t.after(()=>queue.close());const job=queue.submit({});
 assert.throws(()=>queue.submit({}),error=>error.code==='QUEUE_FULL');
 await delay(20);assert.equal(queue.status(job.jobId).status,'running');
});
test('RAG HTTP transport accepts long configured timeouts without overflowing',async()=>{
 for(const timeoutMs of [600000,2147483648]){
  let observedSignal;
  const result=await requestJson('http://127.0.0.1',{timeoutMs,fetchImpl:async(url,{signal})=>{
   observedSignal=signal;await delay(20);signal.throwIfAborted();return new Response('{"ok":true}');
  }});
  assert.deepEqual(result,{ok:true});assert.equal(observedSignal.aborted,false);
 }
});
test('queue distinguishes queued/running and preserves FIFO under concurrency one',async t=>{const releases=[];const starts=[];const queue=new JobQueue(request=>new Promise(resolve=>{starts.push(request);releases.push(resolve);}),{concurrency:1});t.after(()=>queue.close());const first=queue.submit('first'),second=queue.submit('second');assert.equal(second.status,'queued');await until(()=>releases.length===1);assert.equal(queue.status(first.jobId).status,'running');assert.equal(queue.status(second.jobId).queuePosition,1);releases[0]('one');await until(()=>releases.length===2);assert.deepEqual(starts,['first','second']);releases[1]('two');await until(()=>queue.status(second.jobId).status==='completed');assert.equal(queue.result(first.jobId).result,'one');});
test('queue cancellation drops late result and queued cancellation does not execute',async t=>{let release;let started=0;const queue=new JobQueue(()=>{started++;return new Promise(resolve=>{release=resolve;});},{concurrency:1});t.after(()=>queue.close());const a=queue.submit({}),b=queue.submit({});await until(()=>started===1);queue.cancel(b.jobId);queue.cancel(a.jobId);release('late');await delay(10);assert.equal(queue.result(a.jobId).status,'cancelled');assert.equal('result' in queue.result(a.jobId),false);assert.equal(started,1);});
test('deadline includes queue wait and fails with TIMEOUT; backpressure is bounded',async t=>{const queue=new JobQueue(()=>new Promise(()=>{}),{concurrency:1,maxJobs:2,timeoutMs:15});t.after(()=>queue.close());const a=queue.submit({}),b=queue.submit({});assert.throws(()=>queue.submit({}),error=>error.code==='QUEUE_FULL');await delay(35);for(const job of [a,b]){assert.equal(queue.status(job.jobId).status,'failed');assert.equal(queue.status(job.jobId).error.code,'TIMEOUT');}});
test('terminal jobs expire and failed workers retain no accidental result',async t=>{const queue=new JobQueue(async()=>{throw Error('internal secret details');},{retentionMs:20});t.after(()=>queue.close());const job=queue.submit({});await until(()=>queue.status(job.jobId).status==='failed');assert.equal(JSON.stringify(queue.result(job.jobId)).includes('internal secret'),false);await delay(30);assert.throws(()=>queue.status(job.jobId),error=>error.code==='NOT_FOUND');});
test('HTTP client submits reads result and resolves exact evidence',async t=>{const index=await buildIndex({manifestPath:example});const {server:s}=createRagServer({index,token:'local-test-only'});s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}));const endpoint='http://127.0.0.1:'+s.address().port;const client=new RagClient({endpoint,token:'local-test-only'});const job=await client.submit({query:'Retry-After',mode:'hybrid'});assert.ok(job.jobId);await until(async()=>((await client.status(job.jobId)).status==='completed'));const result=await client.result(job.jobId);assert.equal(result.result.results[0].documentId,'retry-after');const cited=await client.read(result.result.results[0].chunkId);assert.equal(cited.text,result.result.results[0].text);await assert.rejects(new RagClient({endpoint}).submit({query:'x'}),error=>error.status===401);await assert.rejects(client.submit({query:'x',oracle:'forbidden'}),error=>error.status===400);});
test('HTTP cancel reports cancellation without holding request until retrieval completes',async t=>{const index=await buildIndex({manifestPath:example});const {server:s}=createRagServer({index,search:async(_i,_r,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}));const client=new RagClient({endpoint:'http://127.0.0.1:'+s.address().port});const job=await client.submit({query:'test'});assert.equal((await client.cancel(job.jobId)).status,'cancelled');assert.equal((await client.result(job.jobId)).status,'cancelled');});
test('LAN endpoint policy rejects public DNS/IP and LAN bind without authentication',()=>{for(const endpoint of ['https://example.org/v1','http://8.8.8.8','http://127.0.0.1/?key=x','http://user:pass@127.0.0.1'])assert.throws(()=>new RagClient({endpoint}));assert.throws(()=>createRagServer({host:'192.168.1.2'}),/token/);});
test('OpenAI-compatible embedding adapter validates batch order using local mock only',async t=>{let request;const endpoint=await server(t,async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]}));});const adapter=new EmbeddingAdapter({endpoint:endpoint+'/v1/embeddings',model:'mock-only',revision:'fixture'});assert.deepEqual(await adapter.embed(['a','b']),[[1,0],[0,1]]);assert.deepEqual(request,{model:'mock-only',input:['a','b']});});
test('rerank adapter maps documented schema and rejects invalid responses',async()=>{const good=new RerankAdapter({endpoint:'http://127.0.0.1/rerank',model:'mock',revision:'fixture'},{fetchImpl:async()=>new Response(JSON.stringify({results:[{index:1,relevance_score:.8},{index:0,relevance_score:.2}]}))});assert.deepEqual(await good.rerank('q',['a','b']),[{index:1,score:.8},{index:0,score:.2}]);const bad=new EmbeddingAdapter({endpoint:'http://127.0.0.1/embeddings',model:'mock',revision:'fixture'},{fetchImpl:async()=>new Response(JSON.stringify({data:[{index:0,embedding:[0,0]}]}))});await assert.rejects(bad.embed(['x']),/Invalid embedding/);});
test('adapter refuses redirects and bounds response bytes',async t=>{const endpoint=await server(t,(req,res)=>{res.writeHead(302,{location:'http://8.8.8.8/'});res.end();});await assert.rejects(requestJson(endpoint));await assert.rejects(requestJson('http://127.0.0.1',{maxBytes:3,fetchImpl:async()=>new Response('{"abc":1}')}),/byte budget/);});
test('HTTP request timeout and external cancellation propagate',async t=>{const endpoint=await server(t,()=>{});await assert.rejects(requestJson(endpoint,{timeoutMs:15}));const c=new AbortController();const pending=requestJson(endpoint,{signal:c.signal,timeoutMs:1000});c.abort();await assert.rejects(pending);});
