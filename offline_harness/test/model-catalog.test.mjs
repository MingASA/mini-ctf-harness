import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelCatalog,localOrigin,windowsPath} from '../src/model-catalog.mjs';
import {InteractiveSession} from '../src/interactive-session.mjs';
import {Contest} from '../src/contest.mjs';
import {KvCache} from '../src/kv-cache.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'models-'));
const cfg=root=>({runDir:root,model:'alpha',baseUrl:'http://127.0.0.1:8080',contextTokens:30000,promptTokens:15000,generationTokens:1024,reasoningTokens:512,maxSeconds:30,maxTurns:30,maxGeneratedTokens:30000});
const options={guard:()=>{},broker:{validate:async()=>{}},knowledge:{search:()=>[]}};
function backend({model='alpha',context=30000}={}){const state={model,context,requests:[]};state.fetch=async(url,opt={})=>{state.requests.push({url,body:opt.body});return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/v1/models')?{data:[{id:state.model}]}:url.endsWith('/slots')?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:state.context}});};return state;}
test('model list merges current, configured and service-discovered entries without generation',async()=>{
 const b=backend(),catalog=new ModelCatalog({discoverLocalModels:false,models:[{id:'beta-small',model:'beta',baseUrl:'http://127.0.0.1:8082'}]},{fetchFn:async(url,opt)=>url.startsWith('http://127.0.0.1:8082')?Response.json({data:[{id:'beta'},{id:'extra'}]}):b.fetch(url,opt)});
 const list=await catalog.list(cfg('unused'));assert.deepEqual(list.map(p=>p.model),['alpha','beta','extra']);assert.equal(list[0].current,true);assert.equal(list[1].online,true);assert.equal(catalog.resolve('2',cfg('unused')).id,'beta-small');assert.equal(catalog.resolve('beta',cfg('unused')).id,'beta-small');assert.equal(b.requests.length,1);assert.ok(b.requests.every(r=>r.url.endsWith('/v1/models')));
});
test('offline catalog retains configured entries and excludes public origins',async()=>{
 const catalog=new ModelCatalog({discoverLocalModels:false,models:[{id:'beta'}]},{fetchFn:async()=>{throw Error('offline');}});const list=await catalog.list(cfg('unused'));assert.equal(list.length,2);assert.ok(list.every(p=>p.online===false));assert.throws(()=>localOrigin('https://example.com'),/loopback/);assert.throws(()=>localOrigin('http://127.0.0.1:8080/path'),/loopback/);assert.equal(windowsPath('/mnt/d/Models/model path.gguf'),'D:\\Models\\model path.gguf');
});
test('switch checks actual backend alias/context and retains cumulative limits',async()=>{
 const b=backend({model:'beta'}),catalog=new ModelCatalog({discoverLocalModels:false},{fetchFn:b.fetch});const original=cfg('unused');
 const {settings}=await catalog.activate({id:'beta',model:'beta',baseUrl:original.baseUrl,contextTokens:20000},original).catch(error=>{assert.match(error.message,/context/);b.context=20000;return catalog.activate({id:'beta',model:'beta',baseUrl:original.baseUrl,contextTokens:20000},original);});
 assert.equal(settings.model,'beta');for(const key of ['maxSeconds','maxTurns','maxGeneratedTokens','generationTokens','reasoningTokens'])assert.equal(key in settings,false);assert.equal(settings.localRecovery,null);assert.equal(settings.verifyModel,true);
 b.model='wrong';await assert.rejects(catalog.activate({id:'beta',model:'beta',baseUrl:original.baseUrl},original),/different model/);
});
test('durable model overlay reopens with the original frozen config and retains messages/effort',()=>{
 const root=temp();try{const config=cfg(root),task={id:'overlay',objective:'Model overlay'};let s=new InteractiveSession(task,config,options);s.requestEffort('low','768');s.store.append('message',{role:'user',content:'keep original instruction'});const before=s.messages();s.selectModel({model:'beta',baseUrl:'http://127.0.0.1:8082',modelSelection:'beta',verifyModel:true,localRecovery:null},{model:'beta'});s=new InteractiveSession(task,config,options);assert.equal(s.config.model,'beta');assert.equal(s.config.reasoningEffort,'low');assert.equal(s.config.reasoningTokens,768);assert.deepEqual(s.messages(),before);assert.equal(s.config.maxSeconds,30);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('switch invalidates old serialized KV even after returning to the same model',async()=>{
 const root=temp();try{const s=new InteractiveSession({id:'kv',objective:'KV invalidation'},cfg(root),options);s.config.kv={enabled:true,identity:'pinned'};s.store.snapshot('kv-checkpoint',{taskId:'kv',identity:new KvCache(s.config).identity(),compactSeq:null,modelEpoch:null,filename:'ctf-kv-1234567890abcdef.bin'});s.store.append('kv_invalidated',{reason:'model_switch'});let calls=0;const kv=new KvCache(s.config,{fetchFn:()=>calls++,guard:()=>{}});assert.equal((await kv.restore(s)).status,'stale');assert.equal(calls,0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('contest model selection preserves task/config identity, persists default and leaves scheduler paused',async()=>{
 const root=temp();let c;const b=backend({model:'beta'});const config={contestDir:path.join(root,'contest'),model:cfg(''),discoverLocalModels:false,models:[{id:'beta',baseUrl:'http://127.0.0.1:8080',contextTokens:30000}]};
 const opts={testMode:true,guard:()=>{},modelFetch:b.fetch,sessionOptions:()=>options,provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {workDir,containerId:id};}};
 try{c=new Contest(config,opts);await c.add({id:'task',objective:'Persistent model change'});const original=structuredClone(c.records.get('task').config);await c.models('task');await c.switchModel('task','beta');assert.equal(c.session('task').config.model,'beta');assert.equal(c.enabled,false);assert.deepEqual(c.records.get('task').config,original);assert.ok(c.session('task').store.events.some(e=>e.type==='kv_invalidated'));await c.close();c=new Contest(config,opts);assert.equal(c.session('task').config.model,'beta');assert.equal(c.defaultModel.model,'beta');}finally{await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('a failed model identity probe cannot replace the current selection',async()=>{
 const root=temp();let c;try{const b=backend({model:'alpha'});const config={contestDir:path.join(root,'contest'),model:cfg(''),discoverLocalModels:false,models:[{id:'beta',contextTokens:30000}]};c=new Contest(config,{testMode:true,guard:()=>{},modelFetch:b.fetch});await c.models();await assert.rejects(c.switchModel(undefined,'beta'),/different model/);assert.equal(c.defaultModel.model,'alpha');assert.equal(fs.existsSync(path.join(c.root,'model-selection.json')),false);assert.equal(c.enabled,false);}finally{await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('managed loading uses a detached native launcher and verifies identity after loading',async()=>{
 const root=temp();try{
  const modelPath=path.join(root,'fixture.gguf'),exe=path.join(root,'llama-server.exe');fs.writeFileSync(modelPath,'GGUF');fs.writeFileSync(exe,'fixture');let ready=false,launched=0;
  const b=backend({model:'beta'});const catalog=new ModelCatalog({contestDir:root,discoverLocalModels:false,modelRuntime:{exe,runDir:path.join(root,'runtime'),platform:'linux'}},{fetchFn:async(...args)=>{if(!ready)throw TypeError('loading');return b.fetch(...args);},executeFn:async(cmd,args,opt)=>{launched++;assert.ok(args.some(a=>a.endsWith('managed_server.py')));assert.equal(opt.cwd,root);const selection=JSON.parse(fs.readFileSync(path.join(root,'runtime/selection.json')));fs.writeFileSync(path.join(root,'runtime/owner.json'),JSON.stringify({key:selection.key}));ready=true;return {stdout:'{}'};}});
  const {receipt}=await catalog.activate({id:'beta',model:'beta',modelPath,baseUrl:'http://127.0.0.1:8080'},cfg(root));assert.equal(receipt.model,'beta');assert.equal(launched,1);assert.ok(JSON.parse(fs.readFileSync(path.join(root,'runtime/selection.json'))).args.includes('--slots'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('managed vision relaunches on an explicit projector device choice and persists it for the next activation',async()=>{
 const root=temp();try{
  const modelPath=path.join(root,'fixture.gguf'),mmprojPath=path.join(root,'projector.gguf'),exe=path.join(root,'llama-server');
  for(const file of [modelPath,mmprojPath,exe])fs.writeFileSync(file,'fixture');
  const launches=[],runDir=path.join(root,'runtime'),b=backend({model:'vision'});
  const catalog=new ModelCatalog({contestDir:root,modelRuntime:{exe,runDir,platform:'linux'}},{
   fetchFn:b.fetch,executeFn:async()=>{
    const launch=JSON.parse(fs.readFileSync(path.join(runDir,'selection.json')));
    fs.writeFileSync(path.join(runDir,'owner.json'),JSON.stringify({key:launch.key}));launches.push(launch);return {stdout:'{}'};
   }});
  const profile={id:'vision',model:'vision',modelPath,mmprojPath,nativeImages:true,baseUrl:'http://127.0.0.1:8080'};
  const base=cfg(root);
  assert.equal((await catalog.activate(profile,base)).settings.projectorDevice,'cpu');
  const {settings}=await catalog.activate(profile,base,{projectorDevice:'gpu'});
  assert.equal(settings.projectorDevice,'gpu');
  await catalog.activate(profile,{...base,...settings});
  assert.equal(launches.length,2);
  assert.ok(launches[0].args.includes('--no-mmproj-offload'));
  assert.ok(launches[1].args.includes('--mmproj-offload'));
  assert.notEqual(launches[0].key,launches[1].key);
  assert.throws(()=>catalog.settings(profile,base,{projectorDevice:'remote'}),/cpu or gpu/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
