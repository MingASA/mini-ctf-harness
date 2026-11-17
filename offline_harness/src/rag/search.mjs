import {cosine,tokenize} from './text.mjs';

const own = (object,key) => Object.hasOwn(object,key) ? object[key] : 0;
const order = (a,b) => b.score-a.score || a.ordinal-b.ordinal;
export function bm25(index,query,{k1=1.2,b=0.75}={}) {
  const terms=[...new Set(tokenize(query))];
  const {count,averageLength,df}=index.statistics;
  return index.chunks.map((chunk,ordinal)=>{
    let score=0;
    for (const term of terms) {
      const frequency=own(chunk.tf,term);
      if (!frequency) continue;
      const idf=Math.log(1+(count-own(df,term)+0.5)/(own(df,term)+0.5));
      score+=idf*(frequency*(k1+1))/(frequency+k1*(1-b+b*chunk.length/(averageLength||1)));
    }
    return {chunkId:chunk.id,documentId:chunk.documentId,score,ordinal};
  }).filter(row=>row.score>0).sort(order);
}
// Frozen v0 scoring: title substring 4 + tag substring 3 + body substring 1 per query term.
// It searches whole documents, matching the former Knowledge.search scoring policy.
export function keywordBaseline(index,query) {
  const terms=query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)||[];
  return index.documents.map((doc,ordinal)=>{
    const score=terms.reduce((s,t)=>s+(doc.title.toLowerCase().includes(t)?4:0)+
      (doc.tags.join(' ').toLowerCase().includes(t)?3:0)+(doc.text.toLowerCase().includes(t)?1:0),0);
    const chunks=index.chunks.filter(c=>c.documentId===doc.id);
    const best=chunks.map((c,i)=>({c,i,score:terms.filter(t=>c.text.toLowerCase().includes(t)).length}))
      .sort((a,b)=>b.score-a.score||a.i-b.i)[0]?.c;
    return {chunkId:best?.id,documentId:doc.id,score,ordinal};
  }).filter(row=>row.score>0&&row.chunkId).sort(order);
}
export function rrf(rankings,{constant=60}={}) {
  if (!Number.isFinite(constant)||constant<1) throw Error('Invalid RRF constant');
  const scores=new Map();
  for (const list of rankings) {
    const seen=new Set();
    for (const [rank,item] of list.entries()) {
      if (seen.has(item.chunkId)) continue;
      seen.add(item.chunkId);
      const row=scores.get(item.chunkId)||{...item,score:0};
      row.score+=1/(constant+rank+1);scores.set(item.chunkId,row);
    }
  }
  return [...scores.values()].sort(order);
}
export function evidence(index,chunkId) {
  const chunk=index.chunks.find(c=>c.id===chunkId);
  if (!chunk) throw Error('Unknown evidence chunk');
  const doc=index.documents.find(d=>d.id===chunk.documentId);
  return {chunkId,documentId:doc.id,title:doc.title,text:chunk.text,
    citation:`rag:${index.indexVersion}:${chunkId}:${chunk.sha256.slice(0,16)}`,
    indexVersion:index.indexVersion,source:{...doc.source,path:doc.path,sha256:doc.sha256,
      startByte:chunk.startByte,endByte:chunk.endByte,chunkSha256:chunk.sha256}};
}
function uniqueDocuments(rows) {
  const seen=new Set();
  return rows.filter(row=>{if(seen.has(row.documentId))return false;seen.add(row.documentId);return true;});
}
export async function searchIndex(index,{query,topK=5,mode='bm25',rerank=false,candidateCount=100}={},
  {embedding=null,reranker=null,signal}={}) {
  if (typeof query!=='string'||!query.trim()||query.length>4096||!Number.isInteger(topK)||topK<1||topK>50||
      !['keyword','bm25','hybrid'].includes(mode)||!Number.isInteger(candidateCount)||candidateCount<topK||candidateCount>500||typeof rerank!=='boolean') throw Error('Invalid search request');
  signal?.throwIfAborted();
  let rows=mode==='keyword'?keywordBaseline(index,query):bm25(index,query);
  const components={lexical:mode==='keyword'?'keyword-v0':'bm25',embedding:{status:'disabled'},rerank:{status:'disabled'}};
  let effectiveMode=mode==='keyword'?'keyword':'bm25';
  if (mode==='hybrid') {
    if (!embedding || !index.vectorData) components.embedding={status:'unavailable',reason:!embedding?'embedding_not_configured':'index_has_no_vectors'};
    else if (embedding.identity!==index.vectorData.identity) components.embedding={status:'unavailable',reason:'embedding_identity_mismatch'};
    else {
      try {
        const [vector]=await embedding.embed([query],{signal});
        if (!Array.isArray(vector)||vector.length!==index.vectorData.dimension||vector.some(x=>!Number.isFinite(x))||!vector.some(x=>x!==0)) throw Error('Invalid query vector');
        const ranked=index.chunks.map((chunk,ordinal)=>({chunkId:chunk.id,documentId:chunk.documentId,ordinal,
          score:cosine(vector,index.vectorData.vectors[ordinal])})).sort(order).slice(0,candidateCount);
        rows=rrf([rows.slice(0,candidateCount),ranked]);
        components.embedding={status:'used',identity:embedding.identity};effectiveMode='hybrid-rrf';
      } catch(error) {
        signal?.throwIfAborted();
        components.embedding={status:'unavailable',reason:'embedding_request_failed',errorCode:error.code||error.name||'Error'};
      }
    }
  }
  let candidates=uniqueDocuments(rows).slice(0,candidateCount);
  if (rerank) {
    if (!reranker) components.rerank={status:'unavailable',reason:'reranker_not_configured'};
    else if (candidates.length) {
      try {
        const ranked=await reranker.rerank(query,candidates.map(row=>evidence(index,row.chunkId).text),{signal,topN:candidates.length});
        if (!Array.isArray(ranked)||ranked.length!==candidates.length||new Set(ranked.map(row=>row.index)).size!==ranked.length||ranked.some(row=>!Number.isInteger(row.index)||row.index<0||row.index>=candidates.length||!Number.isFinite(row.score))) throw Error('Invalid reranker candidate ranking');
        candidates=ranked.map(row=>({...candidates[row.index],rerankScore:row.score}));
        components.rerank={status:'used',identity:reranker.identity};effectiveMode+='-reranked';
      } catch(error) {
        signal?.throwIfAborted();
        components.rerank={status:'unavailable',reason:'rerank_request_failed',errorCode:error.code||error.name||'Error'};
      }
    }
  }
  signal?.throwIfAborted();
  return {indexVersion:index.indexVersion,query,requestedMode:mode,effectiveMode,components,
    results:candidates.slice(0,topK).map((row,position)=>({...evidence(index,row.chunkId),rank:position+1,
      score:row.score,...(row.rerankScore!==undefined?{rerankScore:row.rerankScore}:{})})),
    note:'Retrieved reference text is not an observation about the current task.'};
}
