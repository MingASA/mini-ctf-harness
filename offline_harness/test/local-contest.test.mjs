import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {Contest} from '../src/contest.mjs';import {Store} from '../src/store.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'contest-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[];
 const cfg={contestDir:path.join(root,'contest'),model:{localRecovery:{stateFile:'/synthetic'},maxSeconds:60}};
 const options={testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,id);if(!fs.existsSync(workDir))fs.mkdirSync(workDir);return {workDir,containerId:id};},sessionFactory:record=>Object.assign(new EventEmitter(),{config:record.config,task:record.task,store:new Store(record.config.runDir),pauseRequested:false,inbox:{items:()=>[]},dependencies:()=>[],messages:()=>[],budget:()=>({millisecondsRemaining:60000}),runSlice:async()=>{calls.push(record.task.id);return {status:record.task.id==='broken'?'needs_review':'awaiting_input'};}})};
 return {root,cfg,options,calls};}
test('interactive queue retries locally twice then continues other tasks without a human wake',async t=>{
 const f=fixture(t),c=new Contest(f.cfg,f.options);try{await c.add({id:'broken',objective:'Synthetic failure'});await c.add({id:'next',objective:'Synthetic next task'});c.enabled=true;await c.tick();assert.equal(c.status('broken'),'ready_resume');await c.tick();await c.tick();assert.equal(c.status('broken'),'recovery_failed');await c.tick();assert.equal(c.status('next'),'awaiting_input');assert.deepEqual(f.calls,['broken','broken','broken','next']);}finally{await c.close();}
});
test('terminal restart requeues an interrupted running session only when local recovery is enabled',async t=>{
 const f=fixture(t);let c=new Contest(f.cfg,f.options);await c.add({id:'broken',objective:'Synthetic interruption'});c.queue.take();await c.close();c=new Contest(f.cfg,f.options);try{assert.equal(c.status('broken'),'ready_resume');assert.equal(c.session('broken').store.events.filter(e=>e.type==='local_session_recovery').length,1);}finally{await c.close();}
});
