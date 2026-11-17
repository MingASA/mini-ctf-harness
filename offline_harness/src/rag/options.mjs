import {DATA_ROOT} from '../paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {EmbeddingAdapter,RerankAdapter} from './adapters.mjs';
export const DEFAULT_RAG_ROOT=path.join(DATA_ROOT,'rag');
export function options(argv,allowed) {
  const result={};
  for(let i=0;i<argv.length;i+=2){const key=argv[i]?.replace(/^--/,'');if(!argv[i]?.startsWith('--')||!allowed.includes(key)||!argv[i+1]||argv[i+1].startsWith('--')||Object.hasOwn(result,key))throw Error('Invalid or duplicate CLI option');result[key]=argv[i+1];}
  return result;
}
export function adapters(filename) {
  if(!filename)return {embedding:null,reranker:null};
  const configuration=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(Object.keys(configuration).some(k=>!['embedding','reranker'].includes(k)))throw Error('Unknown adapter configuration key');
  return {embedding:configuration.embedding?new EmbeddingAdapter(configuration.embedding):null,
    reranker:configuration.reranker?new RerankAdapter(configuration.reranker):null};
}
