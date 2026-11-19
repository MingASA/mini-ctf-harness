import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {hash} from './store.mjs';
import {ramKvLimits,ramKvLocation,ramKvProfile} from './ram-kv.mjs';
const execute=promisify(execFile);
const WINDOWS_POWERSHELL='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export function localOrigin(value){
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('Model service must use a loopback HTTP origin');
 return url.origin;
}
export function windowsPath(value){
 const match=/^\/mnt\/([a-z])\/(.+)$/i.exec(path.resolve(value));if(!match)throw Error('Managed Windows model paths must be on a mounted drive');
 return match[1].toUpperCase()+':\\'+match[2].replaceAll('/','\\');
}
export function windowsInteropEnv(){
 const env={...process.env};if(env.WSL_INTEROP&&fs.existsSync(env.WSL_INTEROP))return env;
 if(fs.existsSync('/run/WSL')){const sockets=fs.readdirSync('/run/WSL').filter(n=>/^\d+_interop$/.test(n)).map(n=>path.join('/run/WSL',n)).filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);if(sockets.length)env.WSL_INTEROP=sockets[0];}return env;
}
const descriptor=profile=>hash(JSON.stringify({id:profile.id,model:profile.model,baseUrl:profile.baseUrl,modelPath:profile.modelPath??null,contextTokens:profile.contextTokens??null}));
export function projectorPlacement(profile,current,choice){
 if(choice!==undefined&&!['cpu','gpu'].includes(choice))throw Error('Projector device must be cpu or gpu');
 const managedVision=profile.modelPath&&(profile.nativeImages??Boolean(current.nativeImages&&profile.mmprojPath));
 if(!managedVision){
  if(choice!==undefined)throw Error('Projector placement requires a managed vision model');
  return null;
 }
 const device=choice??(current.modelSelection===profile.id?current.projectorDevice:undefined)??profile.projectorDevice??'cpu';
 if(!['cpu','gpu'].includes(device))throw Error('Projector device must be cpu or gpu');
 return device;
}
export class ModelCatalog {
 constructor(config,{guard=()=>{},fetchFn=fetch,executeFn=execute}={}){this.config=config;this.guard=guard;this.fetch=fetchFn;this.execute=executeFn;this.cache=[];}
 profiles(current){
  const profiles=new Map();
  const add=value=>{
   const id=value.id??value.model;if(typeof id!=='string'||!id.trim()||id.length>300)throw Error('Invalid model ID');
   const model=value.model??id;if(typeof model!=='string'||!model.trim()||model.length>300)throw Error('Invalid backend model ID');
   const baseUrl=localOrigin(value.baseUrl??current.baseUrl??'http://127.0.0.1:8080');
   if(value.modelPath&&(!path.isAbsolute(value.modelPath)||!value.modelPath.toLowerCase().endsWith('.gguf')))throw Error('Model path must be an absolute GGUF path');
   const profile={...value,id,model,baseUrl,name:value.name??id};profiles.set(id,profile);
  };
  add({id:current.model??'qwen3.8-27b-iq4xs',model:current.model??'qwen3.8-27b-iq4xs',baseUrl:current.baseUrl,contextTokens:current.contextTokens,source:'current'});
  for(const profile of this.config.models??[])add({...profile,source:'configured'});
  return [...profiles.values()];
 }
 async json(origin,route,{signal,method='GET',body,timeout=5000}={}){
  this.guard();signal?.throwIfAborted();
  const response=await this.fetch(localOrigin(origin)+route,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw Error('Model service HTTP '+response.status+' '+route);
  return response.json();
 }
 async list(current,{signal}={}){
  const profiles=this.profiles(current),origins=[...new Set(profiles.map(p=>p.baseUrl))];
  const observations=await Promise.allSettled(origins.map(async origin=>{
   const result=await this.json(origin,'/v1/models',{signal,timeout:2000});
   if(!Array.isArray(result.data)||result.data.some(m=>typeof m.id!=='string'))throw Error('Invalid model catalog');return {origin,models:result.data};
  }));
  for(let i=0;i<observations.length;i++){
   const observed=observations[i];
   for(const profile of profiles.filter(p=>p.baseUrl===origins[i])){
    profile.online=observed.status==='fulfilled'&&observed.value.models.some(m=>m.id===profile.model);
    if(observed.status==='rejected')profile.serviceError=observed.reason.message;
   }
   if(observed.status==='fulfilled')for(const model of observed.value.models)if(!profiles.some(p=>p.baseUrl===origins[i]&&p.model===model.id)){
    let id=model.id;if(profiles.some(p=>p.id===id))id=model.id+'@'+new URL(origins[i]).port;
    profiles.push({id,model:model.id,name:model.id,baseUrl:origins[i],online:true,source:'service'});
   }
  }
  signal?.throwIfAborted();
  this.cache=profiles.map((p,i)=>({...p,number:i+1,current:p.model===current.model&&p.baseUrl===localOrigin(current.baseUrl??'http://127.0.0.1:8080'),installed:p.modelPath?fs.existsSync(p.modelPath):undefined,managed:Boolean(p.modelPath)}));
  return this.cache;
 }
 resolve(value,current){
  const profiles=this.cache.length?this.cache:this.profiles(current),number=/^[1-9][0-9]*$/.test(value)?Number(value):null;
  const matches=profiles.filter(p=>p.model===value);const result=profiles.find(p=>p.id===value)??(number?profiles[number-1]:null)??(matches.length===1?matches[0]:null);
  if(!result)throw Error('Unknown model; use /model to list available models');return result;
 }
 settings(profile,current,{projectorDevice}={}){
  const contextTokens=profile.contextTokens??current.contextTokens;
  if(!Number.isInteger(contextTokens)||contextTokens<current.generationTokens+(current.safetyTokens??2048)+512)throw Error('Model context is too small for the existing output reserve');
  const compactSoftTokens=Math.min(current.compactSoftTokens??Math.min(current.promptTokens,40960),contextTokens-current.generationTokens-(current.safetyTokens??2048));
  return {model:profile.model,modelSelection:profile.id,baseUrl:profile.baseUrl,contextTokens,promptTokens:Math.min(current.promptTokens,contextTokens-current.generationTokens-64),compactSoftTokens,
   nativeImages:profile.nativeImages??(profile.modelPath?Boolean(current.nativeImages&&profile.mmprojPath):current.nativeImages),
   projectorDevice:projectorPlacement(profile,current,projectorDevice),localRecovery:profile.localRecovery??null,
   kv:{...(current.kv??{}),identity:profile.identity??descriptor(profile)},verifyModel:true};
 }
 runtimeRoot(){
  return path.resolve(this.config.modelRuntime?.runDir??path.join(path.dirname(this.config.contestDir),'model-runtime'));
 }
 ramKv(profile,settings){
  const policy=this.config.modelRuntime?.ramKv;
  const spec=policy&&profile?.modelPath&&ramKvProfile(profile.id,profile.kvType??'q8_0',fs.statSync(profile.modelPath).size,settings.contextTokens,profile.mtpTokens);
  if(!spec)return null;
  const linux=this.config.modelRuntime.platform==='linux';
  const tuning={roundTripMiBps:60,admissionSeconds:linux?1:6.5,...spec,...policy,...policy.profiles?.[profile.id.replace(/-vision$/,'')],...policy.profiles?.[profile.id]};
  const {roundTripMiBps,prefillTokensPerSecond,cpuImageSeconds,admissionSeconds}=tuning;
  const limits=ramKvLimits(policy);
  if(![roundTripMiBps,prefillTokensPerSecond].every(x=>Number.isFinite(x)&&x>0))
   throw Error('RAM KV requires measured positive roundTripMiBps and prefillTokensPerSecond');
  if(cpuImageSeconds!==undefined&&(!Number.isFinite(cpuImageSeconds)||cpuImageSeconds<0))
   throw Error('RAM KV cpuImageSeconds must be a nonnegative number');
  if(!Number.isFinite(admissionSeconds)||admissionSeconds<0)
   throw Error('RAM KV admissionSeconds must be a nonnegative number');
  const directory=ramKvLocation(this.runtimeRoot());
  let stage,hostDirectory=directory;
  if(!linux){
   stage=path.join(path.resolve(policy.stagingRoot??this.runtimeRoot()),'slot-staging');
   hostDirectory=windowsPath(stage);
   fs.mkdirSync(stage,{recursive:true,mode:0o700});
   if(!fs.lstatSync(stage).isDirectory()||fs.realpathSync(stage)!==stage)throw Error('Invalid KV staging directory');
  }
  return {...spec,directory,stage,hostDirectory,roundTripMiBps,prefillTokensPerSecond,cpuImageSeconds,admissionSeconds,...limits,
   readWindows:linux?null:()=>Number(execFileSync(this.config.modelRuntime.powershell??WINDOWS_POWERSHELL,
    ['-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'],
    {encoding:'utf8',timeout:5000,env:windowsInteropEnv(),cwd:'/mnt/c'}).trim())/1024};
 }
 ramKvOwned(current){
  if(!this.config.modelRuntime?.ramKv)return null;
  const profile=this.profiles(current).find(p=>p.id===(current.modelSelection??current.model));
  const ram=this.ramKv(profile,current);
  if(!ram)return null;
  const file=path.join(this.runtimeRoot(),'owner.json');
  if(!fs.existsSync(file))return null;
  const owner=JSON.parse(fs.readFileSync(file,'utf8'));
  const slotPathIndex=owner.args?.indexOf('--slot-save-path')??-1;
  if(owner.model!==current.model||owner.baseUrl!==localOrigin(current.baseUrl)||
     owner.contextTokens!==current.contextTokens||!owner.key||!owner.requestId||
     slotPathIndex<0||owner.args[slotPathIndex+1]!==ram.hostDirectory)return null;
  return {...ram,identity:owner.key,processId:owner.requestId,vision:owner.args.includes('--mmproj'),
   cpuProjector:owner.args.includes('--no-mmproj-offload')};
 }
 async verify(profile,settings,signal){
  const health=await this.json(profile.baseUrl,'/health',{signal});if(health.status!=='ok')throw Error('Selected model is not ready');
  const models=await this.json(profile.baseUrl,'/v1/models',{signal});if(!models.data?.some(m=>m.id===profile.model))throw Error('Backend is serving a different model: '+profile.model);
  const props=await this.json(profile.baseUrl,'/props',{signal});if(props.default_generation_settings?.n_ctx!==settings.contextTokens)throw Error('Selected model context does not match its profile');
  const slots=await this.json(profile.baseUrl,'/slots',{signal});if(!Array.isArray(slots)||slots.some(s=>s.is_processing))throw Error('Selected model still has an active request');
  return {model:profile.model,baseUrl:profile.baseUrl,contextTokens:settings.contextTokens};
 }
 async activate(profile,current,{signal,projectorDevice}={}){
  this.guard();signal?.throwIfAborted();const settings=this.settings(profile,current,{projectorDevice});
  let startup;
  if(profile.modelPath){
   if(!fs.existsSync(profile.modelPath))throw Error('Model weight file is missing: '+profile.modelPath);
   const exe=this.config.modelRuntime?.exe??'';if(!fs.existsSync(exe))throw Error('Managed model runtime is missing: '+exe);
   const runtimeRoot=this.runtimeRoot();
   fs.mkdirSync(runtimeRoot,{recursive:true});
   const script=path.join(runtimeRoot,'Terminal-Model.ps1');fs.copyFileSync(new URL('../scripts/Terminal-Model.ps1',import.meta.url),script);
   const hostPath=this.config.modelRuntime?.platform==='linux'?x=>x:windowsPath;
   const port=Number(new URL(profile.baseUrl).port||80),args=['-m',hostPath(profile.modelPath),'--alias',profile.model,'--host','127.0.0.1','--port',String(port),'-c',String(settings.contextTokens),'-np','1','-ngl',String(profile.gpuLayers??99),'--flash-attn','on','-ctk',profile.kvType??'q8_0','-ctv',profile.kvType??'q8_0','-b','64','-ub','32','--fit','off','--load-mode','none','--cache-ram','0','--ctx-checkpoints','2','--checkpoint-min-step','256','--jinja','--metrics','--no-context-shift','--slots'];
   if(settings.nativeImages){
    if(!profile.mmprojPath||!fs.existsSync(profile.mmprojPath))throw Error('Selected model projector is missing');
    args.push('--mmproj',hostPath(profile.mmprojPath),settings.projectorDevice==='gpu'?'--mmproj-offload':'--no-mmproj-offload',
     '--image-max-tokens','8192','--image-min-tokens','1024');
   }
   const ram=this.ramKv(profile,settings);
   if(ram)args.push('--slot-save-path',ram.hostDirectory);
   const ramIdentity=ram?{exeTime:fs.statSync(exe).mtimeMs,projectorTime:settings.nativeImages?fs.statSync(profile.mmprojPath).mtimeMs:null}:undefined;
   const launch={libraryDirs:this.config.modelRuntime?.libraryDirs??[],requestId:crypto.randomUUID(),key:hash(JSON.stringify({profile:descriptor({...profile,contextTokens:settings.contextTokens}),exe,args,weight:fs.statSync(profile.modelPath).mtimeMs,ramIdentity})),model:profile.model,baseUrl:profile.baseUrl,contextTokens:settings.contextTokens,exe:hostPath(exe),args,root:hostPath(runtimeRoot)};
   const ownerFile=path.join(runtimeRoot,'owner.json');
   if(fs.existsSync(ownerFile)&&JSON.parse(fs.readFileSync(ownerFile)).key===launch.key){try{const receipt=await this.verify(profile,settings,signal);return {settings,receipt};}catch(error){if(signal?.aborted)throw error;}}
   const config=path.join(runtimeRoot,'selection.json');fs.writeFileSync(config,JSON.stringify(launch));
   const linux=this.config.modelRuntime?.platform==='linux';
   const binary=linux?'python3':this.config.modelRuntime?.powershell??WINDOWS_POWERSHELL,argv=linux?[new URL('../scripts/managed_server.py',import.meta.url).pathname,config]:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',windowsPath(script),'-Config',windowsPath(config)];
   if(this.execute===execute){
    // The WSL interop relay can outlive PowerShell while its model child is resident.
    // Poll durable ownership + HTTP readiness instead of waiting for relay EOF.
    const child=spawn(binary,argv,{detached:true,stdio:'ignore',env:windowsInteropEnv(),cwd:this.config.modelRuntime?.hostCwd??path.dirname(runtimeRoot)});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    fs.writeFileSync(path.join(runtimeRoot,'launcher.json'),JSON.stringify({relayPid:child.pid,requestId:launch.requestId}));
   }else await this.execute(binary,argv,{timeout:30000,maxBuffer:1024*1024,signal,env:windowsInteropEnv(),cwd:this.config.modelRuntime?.hostCwd??path.dirname(runtimeRoot)});
   startup={root:runtimeRoot,id:launch.requestId,key:launch.key,deadline:Date.now()+(this.config.modelRuntime?.startupTimeoutMs??600000)};
  }
  // Generation is never used as a readiness probe. A late cancellation drains naturally.
  let receipt;
  for(let attempt=0;;attempt++){
   try{if(startup){const ownerFile=path.join(startup.root,'owner.json');if(!fs.existsSync(ownerFile)||JSON.parse(fs.readFileSync(ownerFile)).key!==startup.key)throw Error('Waiting for selected model ownership');}receipt=await this.verify(profile,settings,signal);break;}
   catch(error){
    if(signal?.aborted)throw error;
    const failure=startup&&path.join(startup.root,'launch-failed.json');
    if(failure&&fs.existsSync(failure)){const detail=JSON.parse(fs.readFileSync(failure));if(detail.requestId===startup.id)throw Error(detail.error);}
    if(startup?Date.now()>=startup.deadline:attempt===9||!error.message.includes('active request'))throw error;
    await delay(startup?500:100,undefined,{signal});
   }
  }
  return {settings,receipt};
 }
}
