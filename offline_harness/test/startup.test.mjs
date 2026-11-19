import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Startup,defaultStartConfig,readStartConfig} from '../src/startup.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'startup-'));
function fixture(root){const config=defaultStartConfig();config.runtime.root=path.join(root,'runtime');config.provision.workBase=path.join(root,'offline-harness/work');return config;}
function contest(){const c=new EventEmitter();c.defaultModel={model:'fixture'};c.start=()=>c.enabled=true;c.switchModel=async()=>{c.modelLoaded=true;};return c;}
test('one-click defaults use configurable data paths, preserve adjustable budgets and require no placeholder image',()=>{
 const c=defaultStartConfig();assert.ok(path.isAbsolute(c.contestDir));assert.ok(path.isAbsolute(c.runtime.solverArchive));assert.equal(c.runtime.solverImage,'mini-ctf-tools:1');assert.equal(c.model.contextTokens,55296);assert.equal(c.model.compactSoftTokens,40960);assert.equal(c.model.compactReasoningEffort,'xhigh');assert.equal(c.model.compactReasoningTokens,4096);assert.equal(c.model.compactTokens,8192);
});
test('doctor does not launch Docker, model or compose',()=>{
 const root=temp();try{let launches=0;const c=fixture(root);const startup=new Startup(c,'fixture.json',{executeFn:()=>launches++});const d=startup.doctor();assert.equal(launches,0);assert.equal(d.environment,'offline');assert.equal(d.model,'qwen3.8-27b-iq4xs');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('UI boot gate allows input while Docker starts; tools become available before model load; solver uses selected environment',async()=>{
 const root=temp();let release;const gate=new Promise(r=>release=r);const seen=[];
 try{
  const config=fixture(root),c=contest();const startup=new Startup(config,'fixture.json',{executeFn:async(cmd,args)=>{const action=args[args.indexOf('--config')-1];seen.push({action,args});if(action==='prepare')await gate;return {stdout:JSON.stringify(action==='provision'?{containerId:'new-solver'}:{ready:true})};}});startup.attach(c);
  const pending=startup.start(c);assert.equal(c.booting,true);assert.equal(c.modelLoaded,undefined);release();await pending;assert.equal(c.booting,false);assert.equal(c.modelLoaded,true);assert.equal(c.enabled,true);
  assert.deepEqual(seen.map(x=>x.action),['prepare','environment']);const solver=await startup.provision('fixture',{target:'http://192.168.2.3:8000',environment:'lan'});assert.equal(solver.containerId,'new-solver');assert.ok(seen.at(-1).args.includes('http://192.168.2.3:8000'));assert.ok(seen.at(-1).args.includes('lan'));
  await startup.deprovision('fixture',{containerId:'a'.repeat(64),workDir:path.join(config.provision.workBase,'fixture')});assert.equal(seen.at(-1).action,'deprovision');assert.ok(seen.at(-1).args.includes('a'.repeat(64)));
 }finally{release();fs.rmSync(root,{recursive:true,force:true});}
});
test('failure stays visible, does not start generation, and initialization can be retried',async()=>{
 const root=temp();let failing=true;
 try{const c=contest(),startup=new Startup(fixture(root),'fixture.json',{executeFn:async()=>{if(failing)throw Error('missing image');return {stdout:'{"ready":true}'};}});startup.attach(c);await assert.rejects(startup.start(c),/missing image/);assert.equal(c.enabled,undefined);assert.match(c.bootError,/missing image/);failing=false;await startup.start(c,{noModel:true});assert.equal((await startup.dockerReady).ready,true);assert.equal(c.modelLoaded,undefined);assert.equal(c.bootError,null);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('config override selects a named Web environment without rewriting operator configuration',()=>{
 const root=temp();try{const file=path.join(root,'config.json'),config=defaultStartConfig();config.environments.web={type:'internal',network:'ctf-demo',subnet:'172.28.248.0/24',targetUrl:'http://172.28.248.10:8000'};fs.writeFileSync(file,JSON.stringify(config));const before=fs.readFileSync(file);const read=readStartConfig(file,{environment:'web',model:'qwen3.5-9b-ctf-web-q8',target:'http://192.168.1.20:9000'});assert.equal(read.config.environment,'web');assert.equal(read.config.initialModel,'qwen3.5-9b-ctf-web-q8');assert.equal(read.config.target,'http://192.168.1.20:9000');assert.deepEqual(fs.readFileSync(file),before);assert.throws(()=>readStartConfig(file,{environment:'missing'}),/Unknown environment/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
