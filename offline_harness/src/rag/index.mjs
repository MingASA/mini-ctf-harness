import fs from 'node:fs';
import path from 'node:path';
import {chunkBytes,digest,frequencies,tokenize,TOKENIZER_VERSION} from './text.mjs';

function strictKeys(value, allowed, required=allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) throw Error('Invalid corpus manifest fields');
}
function pinnedFile(root, relative, limit) {
  if (typeof relative !== 'string' || !relative || relative.length > 500 || path.isAbsolute(relative) ||
      relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid corpus relative path');
  let filename = root;
  for (const part of relative.split('/')) {
    filename = path.join(filename,part);
    if (fs.lstatSync(filename).isSymbolicLink()) throw Error('Corpus symlink rejected');
  }
  const fd = fs.openSync(filename,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const actual = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (!stat.isFile() || stat.size > limit || !actual.startsWith(root+path.sep)) throw Error('Corpus file escaped or exceeds import budget');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > limit) throw Error('Corpus file exceeds import budget');
    return bytes;
  } finally {fs.closeSync(fd);}
}
export function readCorpus(manifestPath,{maxFileBytes=8388608,maxTotalBytes=16777216}={}) {
  const absolute = path.resolve(manifestPath);
  const root = fs.realpathSync(path.dirname(absolute));
  const raw = pinnedFile(root,path.basename(absolute),1048576);
  const manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  strictKeys(manifest,['version','documents']);
  if (manifest.version !== 1 || !Array.isArray(manifest.documents) || manifest.documents.length > 4096) throw Error('Unsupported corpus manifest');
  const ids = new Set();
  let total = 0;
  const documents = manifest.documents.map(d => {
    strictKeys(d,['id','title','path','sha256','source','tags'],['id','title','path','sha256','source']);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(d.id || '') || ids.has(d.id) || typeof d.title !== 'string' ||
        !d.title.trim() || d.title.length > 500 || !/^[a-f0-9]{64}$/.test(d.sha256 || '') ||
        (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.length > 32 || d.tags.some(t=>typeof t!=='string'||t.length>80)))) throw Error('Invalid or duplicate corpus document');
    strictKeys(d.source,['uri','revision','scope']);
    if (typeof d.source.uri !== 'string' || d.source.uri.length > 2000 || typeof d.source.revision !== 'string' ||
        !d.source.revision || d.source.revision.length > 200 || !['generic-reference','user-provided'].includes(d.source.scope)) throw Error('Invalid explicit source provenance');
    ids.add(d.id);
    const bytes = pinnedFile(root,d.path,maxFileBytes);
    total += bytes.length;
    if (total > maxTotalBytes || digest(bytes) !== d.sha256) throw Error('Corpus digest changed or import budget exceeded');
    const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    return {...d,tags:d.tags || [],bytes:bytes.length,text};
  });
  return {manifestSha256:digest(raw),documents};
}
export async function buildIndex({manifestPath,indexDir,chunking={maxChunkBytes:2048,overlapBytes:128},embedding=null,signal}={}) {
  signal?.throwIfAborted();
  chunkBytes(Buffer.alloc(0),chunking);
  const corpus = readCorpus(manifestPath);
  const chunks = [];
  for (const doc of corpus.documents) {
    for (const [ordinal,chunk] of chunkBytes(Buffer.from(doc.text,'utf8'),chunking).entries()) {
      const tokens=tokenize(doc.title+'\n'+chunk.text);
      chunks.push({...chunk,id:doc.id+':'+ordinal,documentId:doc.id,ordinal,length:tokens.length,tf:frequencies(tokens)});
    }
  }
  const df=Object.create(null);
  for (const chunk of chunks) for (const term of Object.keys(chunk.tf)) df[term]=(df[term]||0)+1;
  let vectorData=null;
  if (embedding && chunks.length) {
    const vectors=[];
    for (let offset=0;offset<chunks.length;offset+=16) {
      signal?.throwIfAborted();
      vectors.push(...await embedding.embed(chunks.slice(offset,offset+16).map(c=>c.text),{signal}));
    }
    const dimension=vectors[0]?.length;
    if (!dimension || dimension>8192 || vectors.length!==chunks.length || vectors.some(v=>!Array.isArray(v)||v.length!==dimension||v.some(x=>!Number.isFinite(x))||!v.some(x=>x!==0))) throw Error('Invalid imported embeddings');
    vectorData={identity:embedding.identity,dimension,vectors};
  }
  const payload={formatVersion:1,tokenizerVersion:TOKENIZER_VERSION,manifestSha256:corpus.manifestSha256,
    chunking,documents:corpus.documents,chunks,statistics:{count:chunks.length,averageLength:chunks.reduce((s,c)=>s+c.length,0)/(chunks.length||1),df},vectorData};
  const index={...payload,indexVersion:digest(JSON.stringify(payload))};
  if (indexDir) persistIndex(index,indexDir);
  return index;
}
export function persistIndex(index,indexDir) {
  if (index.indexVersion !== versionOf(index)) throw Error('Index identity mismatch');
  const directory=path.resolve(indexDir);
  fs.mkdirSync(path.join(directory,'versions'),{recursive:true,mode:0o700});
  const serialized=JSON.stringify(index)+'\n';
  const file=index.indexVersion+'.json';
  const filename=path.join(directory,'versions',file);
  if (fs.existsSync(filename)) {
    if (fs.readFileSync(filename,'utf8')!==serialized) throw Error('Immutable index version already differs');
  } else fs.writeFileSync(filename,serialized,{flag:'wx',mode:0o600});
  const pointer={version:1,indexVersion:index.indexVersion,file,sha256:digest(serialized)};
  const temp=path.join(directory,'current-'+process.pid+'-'+Date.now()+'.tmp');
  fs.writeFileSync(temp,JSON.stringify(pointer)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temp,path.join(directory,'current.json'));
  return pointer;
}
function versionOf(index) {
  const {indexVersion,...payload}=index;
  return digest(JSON.stringify(payload));
}
export function loadIndex(indexDir,{maxIndexBytes=134217728}={}) {
  const root=fs.realpathSync(indexDir);
  const pointer=JSON.parse(pinnedFile(root,'current.json',4096).toString('utf8'));
  if (pointer.version!==1 || !/^[a-f0-9]{64}$/.test(pointer.indexVersion||'') ||
      pointer.file!==pointer.indexVersion+'.json' || !/^[a-f0-9]{64}$/.test(pointer.sha256||'')) throw Error('Invalid index pointer');
  const bytes=pinnedFile(root,'versions/'+pointer.file,maxIndexBytes);
  if (digest(bytes)!==pointer.sha256) throw Error('Persisted index digest mismatch');
  const index=JSON.parse(bytes.toString('utf8'));
  if (index.formatVersion!==1 || index.tokenizerVersion!==TOKENIZER_VERSION || versionOf(index)!==pointer.indexVersion || index.indexVersion!==pointer.indexVersion) throw Error('Persisted index version mismatch');
  const docMap=new Map(index.documents.map(d=>[d.id,d]));
  if (docMap.size!==index.documents.length) throw Error('Duplicate persisted document');
  const ids=new Set();
  for (const chunk of index.chunks) {
    const doc=docMap.get(chunk.documentId);
    if (!doc || ids.has(chunk.id) || !Number.isInteger(chunk.startByte)||!Number.isInteger(chunk.endByte)||
        chunk.startByte<0 || chunk.endByte<=chunk.startByte || chunk.endByte>doc.bytes ||
        digest(Buffer.from(chunk.text))!==chunk.sha256 ||
        Buffer.from(doc.text).subarray(chunk.startByte,chunk.endByte).toString('utf8')!==chunk.text) throw Error('Invalid persisted evidence range');
    ids.add(chunk.id);
  }
  for (const doc of index.documents) if (digest(Buffer.from(doc.text))!==doc.sha256 || Buffer.byteLength(doc.text)!==doc.bytes) throw Error('Persisted source identity mismatch');
  return index;
}
