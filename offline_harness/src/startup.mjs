import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomic} from './store.mjs';
import {windowsInteropEnv} from './model-catalog.mjs';
import {validateServiceUrl} from './service-endpoint.mjs';
import {DATA_ROOT,CONFIG_FILE} from './paths.mjs';
const execute=promisify(execFile);
export const DEFAULT_START_CONFIG=CONFIG_FILE;
export function defaultStartConfig(){
 const work=path.join(DATA_ROOT,'workspace'),assets=path.join(DATA_ROOT,'assets');
 return {contestDir:path.join(work,'sessions'),modelLease:path.join(work,'model-lease.json'),autoStart:true,environment:'offline',
  model:{mode:'memory-skills',model:'qwen3.8-27b-iq4xs',baseUrl:'http://127.0.0.1:8080',contextTokens:55296,promptTokens:40960,compactSoftTokens:40960,generationTokens:8192,reasoningTokens:-1,reasoningEffort:'medium',safetyTokens:0,compactThinking:true,compactReasoningEffort:'xhigh',compactReasoningTokens:4096,compactTokens:8192,maxTurns:10000,maxGeneratedTokens:10000000,maxSeconds:7200,nativeImages:false,kv:{enabled:false,slot:0,identity:''}},
  runtime:{root:path.join(work,'runtime'),execRoot:path.join(work,'dx'),docker:path.join(work,'bin/docker/docker'),dockerd:path.join(work,'bin/docker/dockerd'),solverImage:'mini-ctf-tools:1',solverArchive:path.join(assets,'solver.tar')},
  provision:{workBase:path.join(work,'offline-harness/work')},solver:{memoryMiB:2048,cpus:1,pids:128,tmpMiB:128},environments:{offline:{type:'offline'},lan:{type:'lan',targetUrl:''}},services:{},importLimits:{maxBytes:209715200,maxFiles:5000}};
}
export function readStartConfig(file=DEFAULT_START_CONFIG,overrides={}){
 file=path.resolve(file);if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(defaultStartConfig(),null,2)+'\n',{flag:'wx',mode:0o600});}
 const config=JSON.parse(fs.readFileSync(file));config.uid=process.getuid();config.gid=process.getgid();
 if(overrides.environment)config.environment=overrides.environment;
 if(overrides.model)config.initialModel=overrides.model;
 if(overrides.projectorDevice!==undefined){
  if(!['cpu','gpu'].includes(overrides.projectorDevice))throw Error('Use --projector-device cpu or gpu');
  config.initialProjectorDevice=overrides.projectorDevice;
 }
 if(overrides.target){validateServiceUrl(overrides.target);config.target=overrides.target;}
 if(!config.environments?.[config.environment??'offline'])throw Error('Unknown environment; configure environments in '+file);
 for(const name of ['contestDir'])if(!path.isAbsolute(config[name]))throw Error('Interactive data needs an absolute path');
 return {config,file};
}
export class Startup {
 constructor(config,file,{executeFn=execute,progress=()=>{}}={}){
  this.config=config;this.file=file;this.execute=executeFn;this.progress=progress;this.environment=config.environment??'offline';
  this.resetDockerReady();
 }
 resetDockerReady(){this.dockerReady=new Promise((resolve,reject)=>{this.resolveDocker=resolve;this.rejectDocker=reject;});this.dockerReady.catch(()=>{});}
 doctor(){
  const assets={docker:this.config.runtime.docker,dockerd:this.config.runtime.dockerd,solverArchive:this.config.runtime.solverArchive};
  return {config:this.file,assets:Object.fromEntries(Object.entries(assets).map(([key,file])=>[key,{path:file,present:fs.existsSync(file)}])),environment:this.environment,model:this.config.initialModel??this.config.model.model,source:new URL('../',import.meta.url).pathname};
 }
 async root(action,args=[],signal){
  const state=path.join(this.config.runtime.root,'operator-config.json');fs.mkdirSync(path.dirname(state),{recursive:true});atomic(state,this.config);
  const helper=[new URL('../scripts/interactive_environment.py',import.meta.url).pathname,action,'--config',state,...args];
  const wsl=Boolean(process.env.WSL_DISTRO_NAME),rootArgs=wsl?['--distribution',this.config.wslDistribution??process.env.WSL_DISTRO_NAME,'--user','root','--exec','nsenter','--mount=/proc/1/ns/mnt','--','python3',...helper]:['-n','python3',...helper];
  const binary=wsl?'/mnt/c/Windows/System32/wsl.exe':process.getuid()===0?'python3':'sudo';
  const result=await this.execute(binary,!wsl&&process.getuid()===0?helper:rootArgs,{signal,timeout:1200000,maxBuffer:1024*1024,env:windowsInteropEnv(),cwd:this.config.modelRuntime?.hostCwd??path.dirname(this.file)});
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
 }
 async provision(id,{target='',environment=this.environment}={}){
  await this.dockerReady;const workDir=path.join(this.config.provision.workBase,id);fs.mkdirSync(workDir,{recursive:true});
  return this.root('provision',['--task',id,'--work-dir',workDir,'--environment',environment,'--target',target]);
 }
 async deprovision(id,sandbox){
  await this.dockerReady;
  return this.root('deprovision',['--task',id,'--work-dir',sandbox.workDir,'--container-id',sandbox.containerId]);
 }
 attach(contest){
  this.contest=contest;if(contest.catalog){const profile=contest.catalog.resolve(this.config.initialModel??contest.defaultModel.modelSelection??contest.defaultModel.model,contest.defaultModel);contest.pendingDefaultModel=contest.catalog.settings(profile,contest.defaultModel,{projectorDevice:this.config.initialProjectorDevice});}
  contest.environmentName=this.environment;contest.newTaskTarget=this.config.target??this.config.environments[this.environment]?.targetUrl??'';
  contest.cancelInitialization=()=>this.controller?.abort();contest.retryInitialization=()=>this.start(contest);
 }
 start(contest=this.contest,{noModel=false}={}){
  if(this.pending)return this.pending;
  if(this.failed)this.resetDockerReady();this.failed=false;this.controller=new AbortController();contest.booting=true;contest.bootError=null;
  const progress=value=>{contest.notice=value;this.progress(value);contest.emit('change');};
  const run=(async()=>{
   try{
    progress('正在准备 Docker 与解题工具…');const docker=await this.root('prepare',[],this.controller.signal);this.resolveDocker(docker);
    progress('正在连接题目环境…');await this.root('environment',['--environment',contest.environmentName],this.controller.signal);
    if(!noModel){
     progress('正在加载模型；可先创建题目，Ctrl+C 可取消加载。');
     await contest.switchModel(undefined,this.config.initialModel??contest.defaultModel.modelSelection??contest.defaultModel.model,
      {projectorDevice:this.config.initialProjectorDevice,initializing:!this.config.initialModel&&!this.config.initialProjectorDevice});
    }
    contest.booting=false;if(this.config.autoStart&&!noModel)contest.start();progress('环境已就绪。Ctrl+N 创建题目，输入题意即可开始。');return {ready:true,docker,model:noModel?null:contest.defaultModel.model};
   }catch(error){this.failed=true;this.rejectDocker(error);contest.booting=false;contest.bootError=error.message;progress('启动未完成：'+error.message+'。检查配置后 /start 重试。');throw error;}
   finally{this.pending=null;}
  })();this.pending=run;contest.initialization=run;run.catch(()=>{});return run;
 }
}
