import {validateServiceUrl} from '../service-endpoint.mjs';

export async function requestJson(endpoint,{method='POST',body,signal,timeoutMs=15000,token,fetchImpl=fetch,maxBytes=4194304}={}) {
  const url=validateServiceUrl(String(endpoint));
  if (!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000) throw Error('Invalid service timeout');
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  const headers={accept:'application/json',...(body!==undefined?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})};
  const response=await fetchImpl(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:combined,redirect:'error'});
  if (response.status>=300&&response.status<400) throw Error('Service redirect rejected');
  const limit=Number(response.headers.get('content-length')||0);
  if (limit>maxBytes) throw Error('Service response exceeds byte budget');
  const reader=response.body?.getReader();
  if (!reader) throw Error('Service response has no body');
  const blocks=[];let size=0;
  try {
    while(true){combined.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('Service response exceeds byte budget');blocks.push(value);}
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  let data;
  try {data=JSON.parse(Buffer.concat(blocks).toString('utf8'));}catch {throw Error('Service returned invalid JSON');}
  if (!response.ok) {const error=Error('Service HTTP '+response.status);error.code='HTTP_'+response.status;error.status=response.status;error.details=data;throw error;}
  return data;
}
function config(config,kind) {
  if (!config||typeof config.model!=='string'||!config.model||config.model.length>200||typeof config.revision!=='string'||!config.revision||config.revision.length>200) throw Error('Model and explicit revision are required');
  const url=validateServiceUrl(config.endpoint);
  const identity=`${kind}:${config.model}@${config.revision}`;
  return {url,identity};
}
export class EmbeddingAdapter {
  constructor(options,{fetchImpl=fetch}={}) {Object.assign(this,config(options,'embedding'));this.options=options;this.fetchImpl=fetchImpl;}
  async embed(input,{signal}={}) {
    if (!Array.isArray(input)||!input.length||input.length>128||input.some(t=>typeof t!=='string'||t.length>65536)) throw Error('Invalid embedding batch');
    const result=await requestJson(this.url,{body:{model:this.options.model,input},signal,timeoutMs:this.options.timeoutMs||15000,
      token:this.options.tokenEnv?process.env[this.options.tokenEnv]:undefined,fetchImpl:this.fetchImpl});
    if (!Array.isArray(result.data)||result.data.length!==input.length) throw Error('Invalid embedding count');
    const rows=[...result.data].sort((a,b)=>a.index-b.index);
    const dimension=rows[0]?.embedding?.length;
    if (!dimension||dimension>8192||rows.some((r,i)=>r.index!==i||!Array.isArray(r.embedding)||r.embedding.length!==dimension||r.embedding.some(n=>typeof n!=='number'||!Number.isFinite(n))||!r.embedding.some(n=>n!==0))) throw Error('Invalid embedding response');
    return rows.map(r=>r.embedding);
  }
}
export class RerankAdapter {
  constructor(options,{fetchImpl=fetch}={}) {Object.assign(this,config(options,'rerank'));this.options=options;this.fetchImpl=fetchImpl;}
  async rerank(query,documents,{signal,topN=documents.length}={}) {
    if (typeof query!=='string'||!Array.isArray(documents)||!documents.length||documents.length>500||documents.some(t=>typeof t!=='string'||t.length>65536)||!Number.isInteger(topN)||topN<1||topN>documents.length) throw Error('Invalid rerank request');
    const result=await requestJson(this.url,{body:{model:this.options.model,query,documents,top_n:topN},signal,
      timeoutMs:this.options.timeoutMs||15000,token:this.options.tokenEnv?process.env[this.options.tokenEnv]:undefined,fetchImpl:this.fetchImpl});
    if (!Array.isArray(result.results)||result.results.length!==topN) throw Error('Invalid rerank count');
    const seen=new Set();
    return result.results.map(row=>{
      if (!Number.isInteger(row.index)||row.index<0||row.index>=documents.length||seen.has(row.index)||typeof row.relevance_score!=='number'||!Number.isFinite(row.relevance_score)) throw Error('Invalid rerank response');
      seen.add(row.index);return {index:row.index,score:row.relevance_score};
    }).sort((a,b)=>b.score-a.score||a.index-b.index);
  }
}
