import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
export class LocalModelRecovery {
 constructor(config,store,{execute=exec}={}){
  this.config=config;this.store=store;this.execute=execute;this.images=new Set();
  if(!config||typeof config.stateFile!=='string'||!path.isAbsolute(config.stateFile))throw Error('Local recovery requires an explicit owner-state path');
 }
 async prepare(body,signal,{force=false}={}){
  const imageHashes=[];
  for(const m of body?.messages||[])if(Array.isArray(m.content))for(const p of m.content)if(p.type==='image_url')imageHashes.push(crypto.createHash('sha256').update(typeof p.image_url==='string'?p.image_url:p.image_url.url).digest('hex'));
  const stamp=fs.statSync(this.config.stateFile).mtimeMs;
  if(!force&&this.ready&&stamp===this.stamp&&imageHashes.every(id=>this.images.has(id)))return;
  const file=path.join(this.store.root,'local-model-request.json');if(body)fs.writeFileSync(file,JSON.stringify(body),{mode:0o600});
  const script=this.config.script;if(!script||!path.isAbsolute(script))throw Error('Local recovery requires an absolute helper script path');
  const args=[script,'--state',this.config.stateFile,...(body?['--request',file]:['--ensure-service'])];
  const result=await this.execute(this.config.python||'python3',args,{timeout:1200000,maxBuffer:1024*1024,signal});
  const receipt=JSON.parse(result.stdout);if(receipt.pass!==true)throw Error('Local model preparation failed');
  this.ready=true;this.stamp=fs.statSync(this.config.stateFile).mtimeMs;for(const id of imageHashes)this.images.add(id);
  this.store.append('local_model_ready',{current_server:receipt.current_server,verified_images:receipt.verified_images,task_tools_replayed:false});
 }
}
