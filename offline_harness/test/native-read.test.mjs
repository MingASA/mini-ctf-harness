import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Skills} from '../src/skills.mjs';
import {createReadTool} from '../src/pi-runtime.mjs';
import {buildTools} from '../src/tools.mjs';
import {systemPrompt} from '../src/runner.mjs';
import {Store} from '../src/store.mjs';
import {InteractiveSession} from '../src/interactive-session.mjs';
import {DockerBroker} from '../src/broker.mjs';
const exec=promisify(execFile);
const temp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'native-read-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};

test('Pi discovers all fifteen skills without a manifest and formats real read locations',()=>{
 const skills=new Skills(),prompt=systemPrompt('memory-skills',skills);
 assert.equal(skills.docs.length,15);assert.deepEqual(skills.diagnostics,[]);
 for(const skill of skills.docs){assert.ok(prompt.includes(skill.name));assert.ok(prompt.includes(skill.filePath));assert.ok(skill.filePath.includes('/.agents/skills/'));}
 assert.ok(prompt.includes('Use the read tool'));assert.ok(!prompt.includes('call Skill'));
 assert.ok(!systemPrompt('memory',skills).includes('<available_skills>'));
});

test('generic native read preserves pagination, large text, evidence and replay; rejects file escapes',async t=>{
 const root=temp(t),skillsRoot=path.join(root,'.agents/skills');fs.mkdirSync(path.join(skillsRoot,'fixture/references'),{recursive:true});
 const entry=path.join(skillsRoot,'fixture/SKILL.md'),reference=path.join(skillsRoot,'fixture/references/guide.md');
 fs.writeFileSync(entry,'---\nname: fixture\ndescription: Trace a synthetic file\n---\nRead references/guide.md');
 fs.writeFileSync(reference,Array.from({length:2100},(_,i)=>'line '+(i+1)).join('\n'));
 // Discovery is Pi-native: even an invalid legacy manifest has no effect.
 fs.writeFileSync(path.join(skillsRoot,'manifest.json'),'not a manifest');
 const skills=new Skills(skillsRoot),store=new Store(path.join(root,'run'));let taskReads=0;
 const broker={readFile:async file=>{taskReads++;assert.equal(file,'/work/task.txt');return Buffer.from('task line one\ntask line two');}};
 const tools=buildTools(store,broker,skills,{}),read=tools.find(t=>t.name==='read');
 assert.deepEqual(read.parameters,createReadTool('/work').parameters);
 assert.ok(!tools.some(t=>['Skill','skill_resources','skill_resource_read'].includes(t.name)));
 const body=await read.execute('entry',{path:entry});assert.match(body.content[0].text,/references\/guide/);
 const first=await read.execute('reference',{path:reference});assert.match(first.content[0].text,/offset=2001/);assert.ok(first.content[0].text.length>5000);
 const last=await read.execute('tail',{path:reference,offset:2001,limit:100});assert.match(last.content[0].text,/line 2100/);
 const task=await read.execute('task',{path:'task.txt',offset:2,limit:1});assert.equal(task.content[0].text,'task line two');
 const restarted=buildTools(new Store(path.join(root,'run')),broker,skills,{}).find(t=>t.name==='read');assert.deepEqual(await restarted.execute('task',{path:'task.txt',offset:2,limit:1}),task);assert.equal(taskReads,1);
 assert.ok(store.events.some(e=>e.type==='artifact'&&['tool:read','reference:read'].includes(e.data.source)));
 const outside=path.join(root,'private-judge');fs.writeFileSync(outside,'SECRET');
 fs.symlinkSync(outside,path.join(skillsRoot,'escape'));
 for(const file of [outside,path.join(skillsRoot,'escape'),'/etc/passwd'])assert.equal((await read.execute('deny-'+file,{path:file})).isError,true);
 assert.equal(store.pending().length,0);
});

test('skill references larger than 8MiB remain readable by line range',async t=>{
 const root=temp(t),file=path.join(root,'large.txt');
 fs.writeFileSync(file,('x'.repeat(1023)+'\n').repeat(9*1024)+'TAIL');
 const read=buildTools(new Store(path.join(root,'run')),{}, {root},{}).find(tool=>tool.name==='read');
 const result=await read.execute('large-reference',{path:file,offset:9*1024+1,limit:1});
 assert.equal(result.isError,undefined);assert.equal(result.content[0].text,'TAIL');
});

test('Docker read adapter reads task bytes with owner identity and rejects non-task paths',async t=>{
 const root=temp(t),work=path.join(root,'offline-harness/work/task');fs.mkdirSync(work,{recursive:true});
 const execute=async(_binary,args,options)=>{assert.deepEqual(args.slice(0,4),['exec','--user',`${process.getuid()}:${process.getgid()}`,'--env']);const at=args.indexOf('python3');const script=args[at+2].replaceAll("'/work/'",JSON.stringify(work+'/'));return exec('python3',['-c',script,...args.slice(at+3)],{maxBuffer:options.maxBuffer});};
 const broker=new DockerBroker({workDir:work,containerId:'fixture'},new Store(path.join(root,'store')),execute);
 fs.writeFileSync(path.join(work,'test.txt'),'hello\n');assert.equal((await broker.readFile(path.join(work,'test.txt'))).toString(),'hello\n');
 const large=Buffer.alloc(21*1024*1024,120);fs.writeFileSync(path.join(work,'large.txt'),large);
 assert.deepEqual(await broker.readFile(path.join(work,'large.txt')),large);
 fs.symlinkSync('/etc/passwd',path.join(work,'escape'));await assert.rejects(broker.readFile(path.join(work,'escape')),/File must be inside/);
 await assert.rejects(broker.readFile('/etc/passwd'),/File must be inside/);
});

test('real Pi interactive loop loads a skill, its relative reference and task file through the same read tool',async t=>{
 const root=temp(t),dir=path.join(root,'.agents/skills/fixture');fs.mkdirSync(path.join(dir,'references'),{recursive:true});
 fs.writeFileSync(path.join(dir,'SKILL.md'),'---\nname: fixture\ndescription: Synthetic discovery canary\n---\nBODY_CANARY: read references/guide.md');
 fs.writeFileSync(path.join(dir,'references/guide.md'),'REFERENCE_CANARY: inspect /work/input.txt');
 const skills=new Skills(path.dirname(dir)),paths=[skills.docs[0].filePath,path.join(dir,'references/guide.md'),'/work/input.txt'];let requests=0;const failures=[];
 const count=b=>Math.ceil(JSON.stringify({messages:b.messages,tools:b.tools}).length/4);
 const server=http.createServer(async(req,res)=>{try{
  if(req.method==='GET'){res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/slots'?[{id:0,is_processing:false}]:{default_generation_settings:{n_ctx:65536}}));return;}
  let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(req.url.endsWith('input_tokens')){res.end(JSON.stringify({input_tokens:count(b)}));return;}
  const turn=requests++;
  assert.ok(b.messages[0].content.includes('Synthetic discovery canary'));assert.ok(!b.messages[0].content.includes('BODY_CANARY'));
  const names=b.tools.map(t=>t.function.name);assert.ok(names.includes('read'));assert.ok(!names.some(n=>['Skill','skill_resources','skill_resource_read'].includes(n)));
  if(turn>0)assert.match(b.messages.findLast(m=>m.role==='tool').content,[/BODY_CANARY/,/REFERENCE_CANARY/,/TASK_CANARY/][Math.min(turn-1,2)]);
  const delta=turn<3?{tool_calls:[{index:0,id:'read-'+turn,function:{name:'read',arguments:JSON.stringify({path:paths[turn]})}}]}:{content:'Files inspected.'};
  res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:turn<3?'tool_calls':'stop'}],usage:{prompt_tokens:count(b),completion_tokens:20,total_tokens:count(b)+20}})+'\n\ndata: [DONE]\n\n');
 }catch(error){failures.push(error);res.statusCode=500;res.end(JSON.stringify({error:error.message}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const session=new InteractiveSession({id:'fixture',objective:'Inspect synthetic files'},{runDir:path.join(root,'run'),baseUrl:'http://127.0.0.1:'+server.address().port,contextTokens:65536,promptTokens:14000,generationTokens:1024,reasoningTokens:512,maxTurns:8,maxGeneratedTokens:8000,maxSeconds:30},{knowledge:skills,broker:{validate:async()=>{},readFile:async()=>Buffer.from('TASK_CANARY')},guard:()=>{}});
 const result=await session.runSlice();assert.deepEqual(failures,[]);assert.equal(result.status,'awaiting_input',JSON.stringify({result,errors:session.store.events.filter(e=>e.type==='model_error'||e.type==='message'&&e.data.errorMessage)}));assert.equal(requests,4);
});

test('native read respects vision admission, preserves PNG bytes and converts GIF for the model transport',async t=>{
 const store=new Store(temp(t)),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO9sAAAAASUVORK5CYII=',gif='R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
 const broker={readFile:async file=>Buffer.from(file.endsWith('.png')?png:gif,'base64')};
 const disabled=buildTools(store,broker,{},{}).find(t=>t.name==='read');assert.equal((await disabled.execute('disabled',{path:'image.png'})).isError,true);
 const read=buildTools(store,broker,{}, {},()=>{},{nativeImages:true}).find(t=>t.name==='read');
 const result=await read.execute('png',{path:'image.png'});assert.deepEqual(result.content.find(x=>x.type==='image'),{type:'image',mimeType:'image/png',data:png});
 const converted=await read.execute('gif',{path:'image.gif'});assert.equal(converted.isError,undefined,JSON.stringify(converted));assert.equal(converted.content.find(x=>x.type==='image').mimeType,'image/png');
});
