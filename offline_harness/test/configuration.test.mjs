import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,hash} from '../src/store.mjs';
import {migrateContextBudget} from '../src/configuration.mjs';
import {runTask} from '../src/runner.mjs';
import {ContextManager} from '../src/context.mjs';

const changes={contextTokens:55296,promptTokens:43008,compactSoftTokens:43008,compactHardTokens:45056,compactTokens:8192,generationTokens:8192,safetyTokens:2048};
const previous={contextTokens:65536,promptTokens:51200,compactSoftTokens:51200,compactHardTokens:55296,generationTokens:8192,safetyTokens:2048,maxSeconds:2400};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);store.append('configuration',{config:previous,sha256:hash(JSON.stringify(previous))});return store;}
test('explicit stopped-task context reduction appends an audit without changing history or solve budget',t=>{
 const s=fixture(t),before=fs.readFileSync(s.file),next={...previous,...changes};
 const e=migrateContextBudget(s,next,'User requested GPU residency repair');
 assert.equal(e.data.previous_sha256,s.events[0].data.sha256);assert.equal(e.data.config.maxSeconds,2400);
 assert.deepEqual(fs.readFileSync(s.file).subarray(0,before.length),before);assert.equal(e.data.migration_type,'operator_context_reduction');
 assert.equal(new ContextManager(s,next).limits().hard+next.compactTokens+next.safetyTokens,55296);
 assert.equal(next.compactHardTokens-next.compactSoftTokens,2048);
 const size=s.events.length;migrateContextBudget(s,next,'Idempotent publication retry');assert.equal(s.events.length,size);
});
test('context migration rejects live ownership, pending tools, unsafe budgets and unrelated changes',t=>{
 const s=fixture(t),next={...previous,...changes};
 for(const bad of [{...next,maxSeconds:2500},{...next,contextTokens:70000},{...next,compactHardTokens:50000}])assert.throws(()=>migrateContextBudget(s,bad,'reviewed repair'));
 assert.equal(s.events.length,1);
 fs.writeFileSync(path.join(s.root,'owner.json'),JSON.stringify({pid:process.pid}));assert.throws(()=>migrateContextBudget(s,next,'reviewed repair'),/Live runner/);fs.unlinkSync(path.join(s.root,'owner.json'));
 s.append('tool_start',{callId:'uncertain',name:'fixture'});assert.throws(()=>migrateContextBudget(s,next,'reviewed repair'),/Uncertain/);
 assert.equal(s.events.filter(e=>e.type==='configuration').length,1);
});
test('approved zero-margin migration preserves frozen history and the cumulative solve snapshot',t=>{
 const s=fixture(t),old={...previous,...changes,compactHardTokens:null,maxSeconds:1800};
 s.append('configuration',{config:old,sha256:hash(JSON.stringify(old))});
 const budgetFile=path.join(s.root,'solve-budget.json'),budget=JSON.stringify({active:false,budget_ms:1800000,used_ms:937788.0599300005});fs.writeFileSync(budgetFile,budget);
 const prefix=fs.readFileSync(s.file),next={...old,safetyTokens:0};
 const e=migrateContextBudget(s,next,'User explicitly cancelled the2K safety reserve');
 assert.deepEqual(e.data.changed_fields,['safetyTokens']);assert.equal(e.data.config.generationTokens,8192);assert.equal(e.data.config.compactTokens,8192);
 assert.equal(new ContextManager(s,next).limits().margin,0);assert.equal(fs.readFileSync(budgetFile,'utf8'),budget);
 assert.deepEqual(fs.readFileSync(s.file).subarray(0,prefix.length),prefix);
});
test('actual Pi resume accepts only the latest audited config and never replays the completed tool',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'context-resume-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let generations=0,context=65536;
 const config={...previous,runDir:root,baseUrl:'http://127.0.0.1:8081',model:'fixture',maxTurns:20,maxGeneratedTokens:100000};
 const fetchFn=async(url,opt)=>{
  if(!opt?.body)return Response.json(url.endsWith('/health')?{status:'ok'}:url.endsWith('/slots')?[]:{default_generation_settings:{n_ctx:context}});
  if(url.endsWith('input_tokens'))return Response.json({input_tokens:100});
  generations++;if(generations===2)return new Response('',{status:500});
  const tool=generations===1,delta=tool?{tool_calls:[{index:0,id:'read',function:{name:'read',arguments:JSON.stringify({path:'/work/fixture.txt'})}}]}:{content:'Synthetic recovery complete'};
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n');
 };
 const options={guard:()=>{},testMode:true,fetchFn,knowledge:{docs:[]},broker:{validate:async()=>{}}},task={id:'configuration-fixture',objective:'Retain one synthetic observation across a reviewed context change.'};
 assert.equal((await runTask(task,config,options)).status,'needs_review');
 const s=new Store(root),prefix=fs.readFileSync(s.file),frozen=s.events.find(e=>e.type==='configuration');
 migrateContextBudget(s,{...frozen.data.config,...changes},'User requested reduced physical context');context=55296;
 await assert.rejects(runTask(task,config,{...options,resume:true}),/configuration changed/);
 const result=await runTask(task,{...config,...changes},{...options,resume:true});assert.equal(result.status,'model_stopped_without_verified_answer');
 const resumed=new Store(root);assert.equal(resumed.events.filter(e=>e.type==='tool_start').length,1);assert.deepEqual(fs.readFileSync(s.file).subarray(0,prefix.length),prefix);
});
