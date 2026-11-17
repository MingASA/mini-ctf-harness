import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadTool,convertToPng} from './pi-runtime.mjs';
import {toolError} from './tool-errors.mjs';
import {hash} from './store.mjs';
import {outputRoot} from './tool-output.mjs';

const within=(file,root)=>file===root||file.startsWith(root+path.sep);
const imageType=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':/^GIF8/.test(bytes.toString('ascii',0,4))?'image/gif':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':bytes.toString('ascii',0,2)==='BM'?'image/bmp':undefined;

export function fileReadTool(store,broker,skills,{nativeImages=false}={}){
 const root=skills?.root&&path.resolve(skills.root);
 const readBytes=async filename=>{
  if(root&&within(filename,root)){
   const [canonical,realRoot]=await Promise.all([fs.realpath(filename),fs.realpath(root)]);
   if(!within(canonical,realRoot))throw Error('File escaped the skills directory');
   const file=await fs.open(canonical,'r');
   try{const stat=await file.stat();if(!stat.isFile()||stat.size>8*1024*1024)throw Error('Read requires a regular file within 8 MiB');return await file.readFile();}finally{await file.close();}
  }
  if(!broker.readFile&&/^\/work\/\.tool-output\/[a-f0-9]{20}\.txt$/.test(filename)){
   const file=path.join(outputRoot(store,broker),path.basename(filename));
   const root=await fs.realpath(outputRoot(store,broker)),canonical=await fs.realpath(file);
   if(!within(canonical,root)||canonical!==file)throw Error('Output file escaped its directory');
   return fs.readFile(canonical);
  }
  if(!within(filename,'/work'))throw Error('Read supports task files under /work and catalogued skill directories');
  if(!broker.readFile)throw Error('Task file reading is unavailable in this broker');
  return Buffer.from(await broker.readFile(filename));
 };
 const template=createReadTool('/work',{autoResizeImages:false});
 return {...template,executionMode:'sequential',description:template.description+' Relative paths start at /work. Skill and reference files are available at the absolute paths in the skill catalog.',
  execute:async(id,args,signal,onUpdate)=>store.execute(id,'read',args,async()=>{
   const cache=new Map();
   const get=async file=>{if(!cache.has(file))cache.set(file,readBytes(file));return cache.get(file);};
   const native=createReadTool('/work',{autoResizeImages:false,operations:{access:async file=>{await get(file);},readFile:get,detectImageMimeType:async file=>{const mime=imageType(await get(file));if(mime&&!nativeImages)throw Error('Native images are disabled for this task');return mime;}}});
   try{
    const result=await native.execute(id,args,signal,onUpdate);
    // The native model adapter accepts PNG/JPEG. Pi converts other supported
    // image formats; keep PNG/JPEG bytes untouched for the native vision cache.
    for(let i=0;i<result.content.length;i++){const block=result.content[i];if(block.type==='image'&&!['image/png','image/jpeg'].includes(block.mimeType)){const png=await convertToPng(block.data,block.mimeType);if(!png)throw Error('Image conversion to PNG failed');result.content[i]={type:'image',...png};}}
    for(const [filename,bytes] of cache){const raw=await bytes;store.put({path:filename,sha256:hash(raw),...(imageType(raw)?{data:raw.toString('base64')}:{text:raw.toString('utf8')})},root&&within(filename,root)?'reference:read':'tool:read');}
    return {...result,details:result.details??{}};
   }catch(error){return {content:[{type:'text',text:toolError(store,'read',id,error)}],isError:true};}
  })};
}
