import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {InteractiveSession} from '../src/interactive-session.mjs';

const task={id:'upgrade',objective:'Analyze the attached binary'};
const options={broker:{},knowledge:{},guard:()=>{}};
function fixture(t){
 const runDir=fs.mkdtempSync(path.join(os.tmpdir(),'sandbox-replacement-'));
 t.after(()=>fs.rmSync(runDir,{recursive:true,force:true}));
 const sandbox={containerId:'old',imageId:'image1',workDir:'/work/task',docker:'/bin/docker',dockerHost:'unix:///docker.sock'};
 const config={runDir,sandbox};
 return {config,session:new InteractiveSession(task,config,options)};
}
test('an explicit image replacement preserves history and permits successive upgrades',t=>{
 const {config,session}=fixture(t);
 session.store.append('message',{role:'user',content:'Keep the analysis'});
 const before=fs.readFileSync(session.store.file,'utf8');
 let from=config.sandbox;
 for(const n of [2,3]){
  const to={...from,containerId:'container'+n,imageId:'image'+n};
  session.store.append('sandbox_replaced',{from,to,reason:'tool_image_upgrade'});
  const reopened=new InteractiveSession(task,{...config,sandbox:to},options);
  assert.deepEqual(reopened.config.sandbox,to);
  assert.equal(reopened.store.events.filter(e=>e.type==='message').length,1);
  from=to;
 }
 assert.ok(fs.readFileSync(session.store.file,'utf8').startsWith(before));
 assert.throws(()=>new InteractiveSession(task,config,options),/differs/);
 assert.throws(()=>new InteractiveSession(task,{...config,sandbox:from,model:'other'},options),/differs/);
});
test('unrecorded container changes remain rejected',t=>{
 const {config}=fixture(t);
 assert.throws(()=>new InteractiveSession(task,{...config,sandbox:{...config.sandbox,containerId:'new'}},options),/differs/);
});
for(const change of ['from','workDir','dockerHost','imageId'])test('rejects invalid replacement: '+change,t=>{
 const {config,session}=fixture(t),from=config.sandbox,to={...from,containerId:'new',imageId:'image2'};
 if(change!=='from')to[change]=change==='imageId'?'':'elsewhere';
 session.store.append('sandbox_replaced',{from:change==='from'?{...from,containerId:'wrong'}:from,to});
 assert.throws(()=>new InteractiveSession(task,{...config,sandbox:to},options),/Invalid durable sandbox replacement/);
});
