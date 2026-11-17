import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hash} from './store.mjs';
export function sourceIdentity(){
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
 try {
  const files=git('ls-files','offline_harness/src','offline_harness/prompts','offline_harness/scripts').split('\n').filter(Boolean);
  const hashes=Object.fromEntries(files.filter(f=>fs.existsSync(path.join(source,f))).map(f=>[f,hash(fs.readFileSync(path.join(source,f)))]));
  return {source,commit:git('rev-parse','HEAD'),dirty:Boolean(git('status','--porcelain')),files:hashes,started_at:new Date().toISOString(),pid:process.pid};
 }catch(error){return {source,commit:'unavailable',dirty:true,error:error.message,started_at:new Date().toISOString(),pid:process.pid};}
}
