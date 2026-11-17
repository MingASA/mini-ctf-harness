import {searchIndex} from './search.mjs';

export function metrics(ranking,relevance,k) {
  const positives=Object.entries(relevance).filter(([,grade])=>grade>0);
  if(!positives.length)throw Error('Evaluation query has no positive relevance judgments');
  const ids=[...new Set(ranking)].slice(0,k);
  const gradeOf=id=>Object.hasOwn(relevance,id)?relevance[id]:0;
  const found=ids.filter(id=>gradeOf(id)>0).length;
  const first=ids.findIndex(id=>gradeOf(id)>0);
  const dcg=ids.reduce((sum,id,i)=>sum+(2**gradeOf(id)-1)/Math.log2(i+2),0);
  const ideal=positives.map(([,grade])=>grade).sort((a,b)=>b-a).slice(0,k)
    .reduce((sum,grade,i)=>sum+(2**grade-1)/Math.log2(i+2),0);
  return {recall:found/positives.length,mrr:first<0?0:1/(first+1),ndcg:ideal?dcg/ideal:0};
}
export async function evaluateRetrieval(index,dataset,{embedding=null,reranker=null,ks=[1,3,5],signal}={}) {
  if(dataset.version!==1||!Array.isArray(dataset.queries)||!dataset.queries.length||dataset.queries.length>10000||ks.some(k=>!Number.isInteger(k)||k<1||k>50))throw Error('Invalid retrieval evaluation dataset');
  const known=new Set(index.documents.map(d=>d.id));const seen=new Set();
  for(const row of dataset.queries){
    if(typeof row.id!=='string'||seen.has(row.id)||typeof row.query!=='string'||!row.query.trim()||!row.relevance||typeof row.relevance!=='object'||Array.isArray(row.relevance))throw Error('Invalid retrieval query');
    seen.add(row.id);
    if(Object.entries(row.relevance).some(([id,grade])=>!known.has(id)||!Number.isInteger(grade)||grade<0||grade>3))throw Error('Invalid document relevance judgment');
  }
  const settings=[{name:'keyword-v0',mode:'keyword'},{name:'bm25',mode:'bm25'},
    {name:'hybrid-rrf',mode:'hybrid',required:embedding&&index.vectorData&&embedding.identity===index.vectorData.identity},
    {name:'bm25-reranked',mode:'bm25',rerank:true,required:reranker}];
  const variants={};
  for(const setting of settings){
    if('required' in setting&&!setting.required){variants[setting.name]={status:'not_measured',reason:setting.rerank?'real_reranker_not_configured':'matching_real_embeddings_not_configured'};continue;}
    const rows=[];
    for(const query of dataset.queries){
      signal?.throwIfAborted();
      const result=await searchIndex(index,{query:query.query,topK:Math.max(...ks),mode:setting.mode,rerank:Boolean(setting.rerank)}, {embedding,reranker,signal});
      if(setting.mode==='hybrid'&&result.components.embedding.status!=='used'||setting.rerank&&result.components.rerank.status!=='used'){
        variants[setting.name]={status:'not_measured',reason:'configured_adapter_unavailable',components:result.components};break;
      }
      const ranking=result.results.map(item=>item.documentId);
      rows.push({id:query.id,query:query.query,relevance:query.relevance,ranking,
        scores:result.results.map(item=>({documentId:item.documentId,score:item.rerankScore??item.score})),
        metrics:Object.fromEntries(ks.map(k=>[k,metrics(ranking,query.relevance,k)]))});
    }
    if(variants[setting.name])continue;
    const aggregate=Object.fromEntries(ks.map(k=>[k,Object.fromEntries(['recall','mrr','ndcg'].map(metric=>[metric,rows.reduce((sum,row)=>sum+row.metrics[k][metric],0)/rows.length]))]));
    variants[setting.name]={status:setting.required?'measured_configured_adapter':'measured_cpu',queries:rows,aggregate,
      ...(setting.required?{adapterIdentity:setting.rerank?reranker.identity:embedding.identity,modelAttestation:'operator configured; model implementation not independently attested'}:{})};
  }
  const delta=Object.fromEntries(ks.map(k=>[k,Object.fromEntries(['recall','mrr','ndcg'].map(metric=>[metric,variants.bm25.aggregate[k][metric]-variants['keyword-v0'].aggregate[k][metric]]))]));
  return {version:1,indexVersion:index.indexVersion,datasetDescription:dataset.description,queryCount:dataset.queries.length,
    diagnosticOnly:true,noCtfSolveClaims:true,baselineDefinition:'Original v0 title/tag/body substring weights 4/3/1, searched over full documents; rankings evaluated at document level.',
    variants,bm25MinusKeyword:delta,interpretation:'Authored retrieval fixtures diagnose ranking behavior. They do not establish competition solve-rate improvement or performance on user documents.'};
}
