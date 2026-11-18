import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Contest} from '../src/contest.mjs';
import {CompetitionTerminal,safeText} from '../src/terminal.mjs';
import {visibleWidth} from '@earendil-works/pi-tui';
class Terminal {
 columns=110;rows=30;kittyProtocolActive=false;output='';
 start(input,resize){this.input=input;this.resize=resize;}stop(){}write(s){this.output+=s;}
 drainInput(){return Promise.resolve();}moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
const delay=()=>new Promise(r=>setTimeout(r,60));
test('transcript labels live and saved reasoning and folds long tool results into a separate view',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-output-ui-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'output',objective:'Render messages in the terminal'});
  const session=c.session('output');
  const persisted={role:'assistant',content:[{type:'thinking',thinking:'之前的思考'},{type:'text',text:'之前的回复'}]};
  const toolResult={role:'toolResult',toolName:'run_command',toolCallId:'call-1',content:[{type:'text',text:JSON.stringify({status:'finished',job_id:'j1',exit_code:0,stdout:Array.from({length:30},(_,i)=>'fixture-file-'+i).join('\n')+'\x1b[35m',stdout_file:'/work/.tool-output/full.txt'})}]};
  session.store.append('message',toolResult);
  session.store.append('message',persisted);
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();
  c.emit('agent',{taskId:'output',event:{type:'message_update',message:{role:'assistant',content:[{type:'thinking',thinking:'实时思考内容'},{type:'text',text:'实时回复内容'}]}}});
  ui.renderNow();
  assert.match(ui.content.text,/\[模型思考 · 生成中\]\n实时思考内容/);
  assert.match(ui.content.text,/\[正式回复 · 生成中\]\n实时回复内容/);
  assert.match(ui.content.text,/\[模型思考\]\n之前的思考/);
  assert.match(ui.content.text,/\[正式回复\]\n之前的回复/);
  assert.match(ui.content.text,/j1 · 已结束 · 退出码 0/);
  assert.match(ui.content.text,/已折叠 · \/tool 1 查看/);
  assert.doesNotMatch(ui.content.text,/fixture-file-29/);
  if(!process.env.NO_COLOR){
   assert.ok(ui.content.text.includes('\x1b[36m[模型思考'));
   assert.ok(ui.content.text.includes('\x1b[32m[正式回复'));
  }
  await ui.submit('/tool 1');ui.renderNow();
  assert.match(ui.content.text,/fixture-file-29/);
  assert.match(ui.content.text,/\/work\/\.tool-output\/full\.txt/);
  assert.ok(!ui.content.text.includes('\x1b'));
  assert.equal(ui.scroll.isFollowingEnd,false);
  await ui.submit('/tab output');ui.renderNow();
  assert.match(ui.content.text,/已折叠/);
  assert.equal(ui.scroll.isFollowingEnd,true);
  for(const line of ui.tui.getScreenLines())assert.ok(visibleWidth(line)<=terminal.columns);
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('actual Pi fullscreen components render Chinese; view switch keeps draft task, restart retains draft and wizard',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-tui-test-'));let c,ui;
 const cfg={contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}};
 const options={testMode:true,guard:()=>{throw Error('No inference in UI test');},provision:async id=>{const dir=path.join(root,id);fs.mkdirSync(dir);return {containerId:id,workDir:dir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{search:()=>[]}})};
 try{
  c=new Contest(cfg,options);await c.add({id:'alpha',title:'第一道题',objective:'测试任务'});await c.add({id:'beta',title:'第二道题',objective:'测试任务'});
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();await delay();
  for(let i=0;i<20&&!ui.tui.getScreenLines().join('\n').includes('CTF 比赛终端');i++)await delay();
  assert.ok(ui.tui.getScreenLines().join('\n').includes('CTF 比赛终端'));
  ui.editor.setText('补充给第一道题');ui.persistDraft();ui.setView('beta');assert.equal(ui.bound,'alpha');await ui.submit(ui.editor.getExpandedText());assert.equal(c.session('alpha').inbox.items()[0].text,'补充给第一道题');assert.equal(c.session('beta').inbox.items().length,0);assert.equal(ui.bound,'beta');
  ui.editor.setText('第二题草稿');ui.persistDraft();ui.beginNew();await ui.wizardSubmit('新题标题');ui.editor.setText('多行题意\n继续粘贴');ui.persistDraft();await delay();
  for(const line of ui.tui.getScreenLines())assert.ok(visibleWidth(line)<=terminal.columns);
  await ui.close();c=new Contest(cfg,options);ui=new CompetitionTerminal(c,{terminal:new Terminal()});assert.equal(ui.wizard.step,1);assert.equal(ui.editor.getExpandedText(),'多行题意\n继续粘贴');assert.equal(ui.drafts.beta,'第二题草稿');
  assert.equal(safeText('\x1b]52;secret\x07').includes('\x1b'),false);
 }finally{await ui?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('TUI discovers installed metadata and queues explicit skill requests on the viewed task',async()=>{
 const {Skills}=await import('../src/skills.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-skills-ui-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference in UI test');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:new Skills()})});
  await c.add({id:'task-a',objective:'UI fixture'});await c.add({id:'task-b',objective:'UI fixture'});
  ui=new CompetitionTerminal(c,{terminal:new Terminal()});const name=c.session('task-a').knowledge.docs[0].name;
  await ui.submit('/skills');const metadata=JSON.parse(ui.detail);assert.equal(metadata.length,15);assert.equal(metadata.some(x=>'text' in x),false);
  ui.setView('task-b');await ui.submit('/use-skill '+name);assert.equal(c.session('task-a').inbox.items().length,0);
  const item=c.session('task-b').inbox.items()[0];assert.equal(item.status,'queued');assert.ok(item.text.includes(name));assert.equal(item.taskId,'task-b');
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('TUI routes Compact and effort to the viewed task while Ctrl+C interrupts the active task and keeps drafts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-controls-ui-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference in UI test');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{search:()=>[]}})});
  await c.add({id:'alpha',objective:'active fixture'});await c.add({id:'beta',objective:'viewed fixture'});
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();await delay();ui.setView('beta');
  await ui.submit('/effort low 768');assert.equal(c.session('beta').config.reasoningEffort,'low');assert.equal(c.session('beta').config.reasoningTokens,768);assert.equal(c.session('alpha').config.reasoningEffort,undefined);
  const compact=[];c.compact=id=>{compact.push(id);return c.session(id).requestCompact();};await ui.submit('/compact');assert.deepEqual(compact,['beta']);
  ui.editor.setText('保留正在输入的草稿');ui.persistDraft();c.enabled=true;c.active='alpha';terminal.input('\x03');await delay();assert.equal(ui.closed,undefined);assert.equal(c.enabled,false);assert.equal(c.session('alpha').pauseRequested,true);assert.equal(c.session('beta').pauseRequested,false);assert.equal(ui.editor.getExpandedText(),'保留正在输入的草稿');
  terminal.input('\x03');await delay();assert.equal(ui.closed,undefined);c.active=null;ui.beginNew();await ui.submit('/quit');assert.equal(ui.closed,true);assert.ok(fs.existsSync(path.join(c.root,'ui-state.json')));
 }finally{if(c)c.active=null;await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('model and environment commands show choices and leave input responsive during model loading',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-model-ui-'));let c,ui,release;
 try{
  const config={contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'},environments:{offline:{type:'offline'},web:{type:'internal',targetUrl:'http://172.28.248.10:8000'}}};
  c=new Contest(config,{testMode:true,guard:()=>{throw Error('No inference in UI test');}});ui=new CompetitionTerminal(c,{terminal:new Terminal()});c.models=async()=>[{id:'small',name:'Small model',number:1,current:true,online:false,managed:true,installed:true,baseUrl:'http://127.0.0.1:8080'}];
  await ui.submit('/model');assert.match(ui.detail,/Small model/);assert.match(ui.detail,/本地已安装/);
  const gate=new Promise(r=>release=r);c.switchModel=async(id,value)=>{assert.equal(id,undefined);assert.equal(value,'1');await gate;c.notice='Ready';};await ui.submit('/model 1');await ui.submit('/env web');assert.equal(c.environmentName,'web');assert.equal(c.newTaskTarget,'http://172.28.248.10:8000');release();await new Promise(r=>setTimeout(r,0));assert.equal(ui.notice,'Ready');
 }finally{release?.();await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('queue exposes manual review and confirms a short candidate ID without running inference',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-review-ui-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'review',title:'人工确认题',objective:'Synthetic review fixture'});
  const result=await c.session('review').tools().find(t=>t.name==='submit_flag').execute('candidate',{candidate:'synthetic'});
  assert.equal(JSON.parse(result.content[0].text).status,'awaiting_review');
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();await ui.submit('/queue');await delay();
  assert.match(ui.content.text,/synthetic/);assert.equal(c.queueRows()[0].reviews[0].review_id,'c1');
  const reviewing=ui.submit('/review');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/选择待确认答案/);terminal.input('\r');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/平台判题结果/);terminal.input('\r');await reviewing;assert.equal(c.status('review'),'correct');assert.equal(c.queueRows()[0].reviews.length,0);
  assert.ok(fs.readdirSync(path.join(c.root,'startups')).length);assert.match(ui.header.text,new RegExp(c.source.commit.slice(0,8)));
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('vision model selection offers CPU and GPU and accepts an explicit device argument',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-projector-ui-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'},
   models:[{id:'vision',modelPath:path.join(root,'vision.gguf'),nativeImages:true}]},{testMode:true,guard:()=>{}});
  const choices=[];
  c.switchModel=async(_id,name,{projectorDevice})=>choices.push([name,projectorDevice]);
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();
  const choosing=ui.submit('/model vision');await delay();
  assert.match(ui.tui.getScreenLines().join('\n'),/CPU.*系统内存/);
  assert.match(ui.tui.getScreenLines().join('\n'),/GPU.*显存/);
  terminal.input('\r');await choosing;
  await ui.submit('/model vision gpu');
  assert.deepEqual(choices,[['vision','cpu'],['vision','gpu']]);
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('RAM KV slash settings work without a selected task, update admission policy and survive restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ram-kv-ui-'));let c,ui;
 const basePolicy={reserveMiB:3072,maxCacheMiB:4096,admissionSeconds:5};
 const cfg={contestDir:root,modelRuntime:{platform:'linux',ramKv:basePolicy}};
 const options={testMode:true,guard:()=>{throw Error('Configuration must not call the model');}};
 try{
  c=new Contest(cfg,options);ui=new CompetitionTerminal(c,{terminal:new Terminal()});
  await ui.submit('/offloadKV config');assert.match(ui.detail,/reserveMiB = 3072 MiB/);
  assert.match(ui.detail,/cpuProjectorReserveMiB = 1280 MiB/);
  await ui.submit('/offloadKV config reserveMiB=4096 cpuProjectorReserveMiB=1536 maxCacheMiB=6144');
  assert.match(ui.detail,/maxCacheMiB = 6144 MiB/);
  assert.deepEqual(c.catalog.config.modelRuntime.ramKv,{reserveMiB:4096,cpuProjectorReserveMiB:1536,maxCacheMiB:6144,admissionSeconds:5});
  await assert.rejects(ui.submit('/offloadKV config reserveMiB=512 maxCacheMiB=-1'),/非负整数/);
  await assert.rejects(ui.submit('/offloadKV config maxCacheMiB=9007199254740992'),/nonnegative integer/);
  await assert.rejects(ui.submit('/offloadKV config typo=4096'),/未知 RAM KV 配置项/);
  assert.equal(c.ramKvSettings().reserveMiB,4096);
  await ui.close();
  c=new Contest(cfg,options);ui=new CompetitionTerminal(c,{terminal:new Terminal()});
  await ui.submit('/offloadKV config');assert.match(ui.detail,/maxCacheMiB = 6144 MiB/);
  await ui.submit('/offloadKV config maxCacheMiB=default reserveMiB=0');
  assert.deepEqual(c.ramKvSettings(),{enabled:true,reserveMiB:0,cpuProjectorReserveMiB:1536,maxCacheMiB:4096});
  assert.deepEqual(cfg.modelRuntime.ramKv,{reserveMiB:3072,maxCacheMiB:4096,admissionSeconds:5});
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('resume and view accept short task numbers and open output from any panel',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-short-view-'));let c,ui;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9',contextTokens:55296,promptTokens:40960,generationTokens:8192}},{testMode:true,guard:()=>{throw Error('No inference');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'task-old-alpha',objective:'first'});await c.add({id:'task-old-beta',objective:'second'});c.session('02').store.append('message',{role:'user',content:'Second session output'});
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();ui.tab='queue';ui.detail='prior panel';await ui.submit('/resume 02');await delay();
  assert.equal(ui.selected,'task-old-beta');assert.equal(ui.tab,'output');assert.equal(ui.detail,null);assert.equal(ui.bound,'task-old-beta');assert.match(ui.content.text,/Second session output/);assert.equal(c.status('02'),'ready_resume');assert.equal(c.active,null);assert.match(ui.binding.text,/已用 0 轮/);assert.match(ui.binding.text,/软线 40K/);assert.match(ui.binding.text,/54K/);assert.ok(!ui.binding.text.includes('剩余'));
  ui.tab='budget';terminal.input('\x12');await delay();assert.equal(ui.tab,'output');
  ui.tab='jobs';await ui.submit('/view 01');assert.equal(ui.tab,'output');assert.equal(ui.selected,'task-old-alpha');assert.match(ui.notice,/01/);
  assert.ok(!ui.sidebar.text.includes('task-old-'));
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
