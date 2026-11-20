import {compactFixture} from './compact-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,hash} from '../src/store.mjs';
import {ContextManager,groups,wire} from '../src/context.mjs';
import {validateSandbox} from '../src/broker.mjs';
import {VerdictChannel} from '../src/tools.mjs';
import {validateTask} from '../src/runner.mjs';
import {assertExperimentIdle,NativeClient} from '../src/native.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'offline-harness-'));
const use=async fn=>{const root=temp();try{return await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};
const msg=(role,content)=>({role,content,timestamp:1});
const counter=async body=>Math.ceil(JSON.stringify(body).length/4);

test('evidence integrity, bounded retrieval and no filesystem traversal',()=>use(root=>{
 const s=new Store(root),ref=s.put('x'.repeat(9000)+'needle','tool:wait_job');
 assert.equal(s.search('needle')[0].id,ref.id);assert.match(s.search('needle')[0].excerpt,/needle/);
 s.put('needle echoed in a search result','tool:evidence_search');
 assert.equal(s.search('needle').length,1);
 assert.equal(s.read(ref.id,9000,10).text,'needle');
 assert.throws(()=>s.read('../secret'),/Invalid/);
 fs.writeFileSync(path.join(root,'artifacts',ref.id),'modified');assert.throws(()=>s.read(ref.id),/integrity/);
}));
test('completed calls replay results; unknown outcomes never replay side effects',()=>use(async root=>{
 const s=new Store(root);let count=0;
 assert.equal(await s.execute('c','x',{},async()=>++count),1);
 assert.equal(await s.execute('c','x',{},async()=>++count),1);assert.equal(count,1);
 await assert.rejects(s.execute('c','x',{a:1},async()=>2),/different/);
 await assert.rejects(s.execute('unknown','x',{},async()=>{throw Error('crash');}),/crash/);
 const r=new Store(root);await assert.rejects(r.execute('unknown','x',{},async()=>++count),/Uncertain/);assert.equal(count,1);
}));
test('journal detects changed events and partial tails',()=>use(root=>{
 const s=new Store(root);s.append('example',{value:1});
 fs.appendFileSync(s.file,'{"unfinished":');assert.throws(()=>new Store(root));
}));
test('context rebuild preserves task, working evidence and complete latest tool group',()=>use(async root=>{
 const s=new Store(root),ref=s.put('important older observation','tool:wait_job');
 const messages=[msg('system','rules'),msg('user','original objective')];
 for(let i=0;i<30;i++) messages.push(msg('assistant',[{type:'thinking',thinking:'long '.repeat(80)},{type:'toolCall',id:'c'+i,name:'work',arguments:{}}]),
 {role:'toolResult',toolCallId:'c'+i,toolName:'work',content:[{type:'text',text:'result '+i}],timestamp:1});
 for(const message of messages)s.append('message',message);
 const cm=new ContextManager(s,{promptTokens:2400,contextTokens:12000,safetyTokens:64,compactTokens:1000,generationTokens:1000,compactTailGroups:1});
 const built=await cm.build(messages,counter,compactFixture);
 assert.ok(built.removed>20);assert.equal(built.messages[1].content,'original objective');
 assert.equal(s.read(ref.id).text,'important older observation');assert.equal(built.messages.at(-1).toolCallId,'c29');assert.equal(s.events.filter(e=>e.type==='compact_commit').length,1);
 assert.ok((await counter(wire(built.messages)))<=2400);assert.equal(messages.length,62);
 groups(built.messages.filter(m=>m.role!=='system'));
 const tooSmallStore=new Store(path.join(root,'too-small')),tooSmall=messages.map((m,i)=>i===1?{...m,content:'Mandatory original task '.repeat(200)}:m);for(const m of tooSmall)tooSmallStore.append('message',m);
 await assert.rejects(new ContextManager(tooSmallStore,{promptTokens:512,contextTokens:12000,safetyTokens:64,compactTokens:1000,generationTokens:1000,compactTailGroups:1}).build(tooSmall,counter,compactFixture),/headroom|budget|No (new|older) safe history/);
 assert.throws(()=>groups([msg('assistant',[{type:'toolCall',id:'open'}])]),/Incomplete/);
}));
test('native image transport keeps tool responses paired and includes pixels in counted request',()=>{
 const messages=[msg('system','rules'),msg('user','inspect image'),msg('assistant',[{type:'toolCall',id:'image',name:'view_image',arguments:{path:'/work/a.png'}}]),
 {role:'toolResult',toolCallId:'image',toolName:'view_image',timestamp:1,content:[{type:'text',text:'task image'},{type:'image',mimeType:'image/png',data:'YWJj'}]}];
 const output=wire(messages);
 assert.equal(output.messages[3].role,'tool');assert.equal(output.messages[3].tool_call_id,'image');
 assert.equal(output.messages[4].role,'user');assert.equal(output.messages[4].content[1].image_url.url,'data:image/png;base64,YWJj');
 groups(messages.slice(1));
});
test('judge emits boolean status only, never private payload fields',()=>use(root=>{
 const inbox=path.join(root,'private');fs.mkdirSync(inbox);
 const v=new VerdictChannel('task',path.join(root,'outbox'),inbox),pending=v.submit('call','candidate');
 fs.writeFileSync(path.join(inbox,pending.submission_id+'.json'),JSON.stringify({id:pending.submission_id,candidate_sha256:hash('candidate'),status:'incorrect',answer:'PRIVATE_GOLD_CANARY',message:'SECRET'}));
 assert.deepEqual(v.submit('call','candidate'),{submission_id:pending.submission_id,status:'incorrect'});
 assert.throws(()=>validateTask({id:'task',objective:'public',gold:'PRIVATE_GOLD_CANARY'}),/public/);
}));
test('active experiment blocks metadata before any fetch',()=>use(async root=>{
 const receipt=path.join(root,'process.json');fs.writeFileSync(receipt,JSON.stringify({pid:process.pid}));
 let requests=0;const c=new NativeClient({baseUrl:'http://127.0.0.1:12345'},new Store(path.join(root,'run')),
 {guard:()=>assertExperimentIdle(receipt),fetchFn:()=>{requests++;throw Error('unexpected');}});
 await assert.rejects(c.count({messages:[],tools:[]}),/Current experiment/);assert.equal(requests,0);
 assert.throws(()=>new NativeClient({baseUrl:'https://example.com'},new Store(path.join(root,'bad'))),/loopback/);
}));
test('sandbox rejects answer mounts, GPU access and public networking',()=>{
 const config={containerId:'id',imageId:'image',workDir:'/safe/work'};
 const c={Id:'id',Image:'image',State:{Running:true},Mounts:[{Destination:'/work',Source:'/safe/work',Type:'bind'}],HostConfig:{NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:128*1024*1024,PidsLimit:64,ReadonlyRootfs:true}};
 assert.equal(validateSandbox(c,[],config),true);
 for(const [memory,pids] of [[65536*1024*1024,65536],[0,0],[0,-1],[undefined,undefined]]){
  const configured=structuredClone(c);configured.HostConfig.Memory=memory;configured.HostConfig.PidsLimit=pids;
  assert.equal(validateSandbox(configured,[],config),true);
 }
 for(const mutate of [x=>x.Mounts.push({Destination:'/answers'}),x=>x.HostConfig.DeviceRequests=[{}],x=>x.HostConfig.NetworkMode='host',x=>x.HostConfig.Privileged=true]){
  const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateSandbox(bad,[],config));
 }
 const net=structuredClone(c);net.HostConfig.NetworkMode='ctf';net.HostConfig.Dns=['127.0.0.1'];
 assert.throws(()=>validateSandbox(net,[{Internal:false,Driver:'bridge'}],config),/internal/);
});
