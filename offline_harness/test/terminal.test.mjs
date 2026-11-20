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
const down='\x1b[B';

test('/knowledge controls only the selected task and reports durable on/off state',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-knowledge-'));
 const contest=new Contest({contestDir:root,model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,provision:async id=>({containerId:id,workDir:path.join(root,'work',id)}),sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
 const ui=new CompetitionTerminal(contest,{terminal:new Terminal()});
 t.after(async()=>{await ui.close();fs.rmSync(root,{recursive:true,force:true});});
 await contest.add({id:'one',objective:'One'});await contest.add({id:'two',objective:'Two'});ui.setView('one');
 await ui.submit('/knowledge off');assert.equal(contest.session('one').knowledgeControls().enabled,false);
 assert.equal(contest.session('two').knowledgeControls().enabled,true);
 await ui.submit('/knowledge');assert.match(ui.notice,/关闭/);
 await assert.rejects(ui.submit('/knowledge maybe'),/用法/);
 await ui.submit('/knowledge on');assert.equal(contest.session('one').knowledgeControls().enabled,true);
});

test('backend slot status stays above the selected panel and follows the active model service',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-slot-status-'));
 const origins=[];
 const defaultOrigin='http://127.0.0.1:9',activeOrigin='http://127.0.0.1:10';
 const contest=new Contest({contestDir:root,model:{baseUrl:defaultOrigin}},{
  testMode:true,
  modelFetch:async url=>{
   origins.push(url);
   if(url.endsWith('/kv-cache'))return new Response('',{status:404});
   return Response.json([{id:0,is_processing:url.startsWith(activeOrigin),n_prompt_tokens:640}]);
  },
  provision:async id=>({containerId:id,workDir:path.join(root,'work',id)}),
  sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}}),
 });
 const ui=new CompetitionTerminal(contest,{terminal:new Terminal()});
 t.after(async()=>{await ui.close();fs.rmSync(root,{recursive:true,force:true});});
 ui.start();
 await delay();
 assert.deepEqual(origins,[defaultOrigin+'/kv-cache',defaultOrigin+'/slots']);
 assert.match(ui.tui.getScreenLines().join('\n'),/slot 0 · 空闲 · 提示 tokens 640/);
 await contest.add({id:'selected',objective:'Show this conversation'});
 await contest.add({id:'active',objective:'Report state from this model service'});
 contest.session('active').config.baseUrl=activeOrigin;
 contest.active='active';
 ui.setView('selected');
 await ui.refreshSlotStatus();
 assert.equal(origins.at(-1),activeOrigin+'/slots');
 for(const panel of ['output','queue','budget']){
  await ui.submit('/tab '+panel);
  ui.renderNow();
  await delay();
  const lines=ui.tui.getScreenLines();
  assert.match(lines.slice(2,6).join('\n'),/slot 0 · 处理中 · 提示 tokens 640/);
  assert.doesNotMatch(ui.content.text,/后端共 .* 个 slot/);
 }
});

test('slash completion describes effort inline and Enter opens a picker with a retryable custom budget',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-effort-picker-'));let c,ui,session;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'fixture',objective:'Exercise keyboard interaction'});session=c.session('fixture');session.running=true;
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();await delay();
  const screen=()=>ui.tui.getScreenLines().join('\n');
  for(const key of '/eff')terminal.input(key);
  await delay();assert.match(screen(),/effort\s+设置正常推理或 Compact/);
  for(const key of 'ort')terminal.input(key);
  await delay();terminal.input('\r');await delay();assert.match(screen(),/选择要调整的思考设置/);
  terminal.input('\r');await delay();assert.match(screen(),/正常推理思考模式 · 当前 medium/);
  terminal.input(down);terminal.input(down);terminal.input('\r');await delay();
  assert.match(screen(),/思考预算 · xhigh/);
  for(let i=0;i<5;i++)terminal.input(down);
  terminal.input('\r');await delay();assert.match(screen(),/自定义思考预算/);
  for(const key of '8192')terminal.input(key);
  terminal.input('\r');await delay();
  assert.match(screen(),/请输入小于 8192 的正整数/);
  assert.equal(session.generationControls().pending,undefined);
  for(let i=0;i<4;i++)terminal.input('\x7f');
  for(const key of '3000')terminal.input(key);
  terminal.input('\r');await delay();
  assert.deepEqual(session.generationControls().pending,{thinking:true,reasoningEffort:'xhigh',reasoningTokens:3000});
  assert.equal(session.generationControls().current.reasoningEffort,'medium');
  assert.equal(ui.tab,'output');
  const cancelled=ui.submit('/effort');await delay();terminal.input('\x1b');await cancelled;
  assert.equal(session.store.events.filter(e=>e.type==='effort_requested').length,1);
  const compact=ui.submit('/effort');await delay();
  terminal.input(down);terminal.input('\r');await delay();
  assert.match(screen(),/Compact 压缩思考模式 · 当前 off/);
  terminal.input(down);terminal.input('\r');await delay();
  terminal.input('\r');await compact;
  assert.equal(session.generationControls('compact').pending.reasoningEffort,'low');
  assert.equal(session.generationControls().pending.reasoningEffort,'xhigh');
  await ui.submit('/effort compact off');
  assert.equal(session.generationControls('compact').pending.thinking,false);
  const priority=ui.submit('/priority');await delay();assert.match(screen(),/调整队列优先级/);
  terminal.input('1');terminal.input('5');terminal.input('\r');await priority;
  assert.equal(c.queue.item('fixture').priority,15);
  session.running=false;
  const window=ui.submit('/context');await delay();
  assert.match(screen(),/后端容量/);
  for(const key of '32K 16K')terminal.input(key);
  terminal.input('\r');await window;
  assert.equal(session.sessionWindow.contextTokens,32768);
  await ui.submit('/context 48K 32K');ui.renderNow();
  assert.match(ui.content.text,/软压缩线 32,768 tokens · 上下文总长 49,152 tokens/);
  const cancelWindow=ui.submit('/context');await delay();terminal.input('\x1b');await cancelWindow;
  assert.equal(session.sessionWindow.contextTokens,49152);
 }finally{if(session)session.running=false;await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

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
  const config={contestDir:path.join(root,'contest'),model:{model:'base',baseUrl:'http://127.0.0.1:9'},models:[{id:'small'}],environments:{offline:{type:'offline'},web:{type:'internal',targetUrl:'http://172.28.248.10:8000'}}};
  c=new Contest(config,{testMode:true,guard:()=>{throw Error('No inference in UI test');}});c.environmentName='offline';
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();
  c.models=async()=>[{id:'base',name:'Base model',number:1,current:true,online:true},{id:'small',name:'Small model',number:2,managed:true,installed:true}];
  const gate=new Promise(r=>release=r);const switched=[];c.switchModel=async(id,value)=>{assert.equal(id,undefined);switched.push(value);await gate;c.notice='Ready';};
  const current=ui.submit('/model');await delay();terminal.input('\r');await current;assert.deepEqual(switched,[]);
  const model=ui.submit('/model');await delay();
  assert.match(ui.tui.getScreenLines().join('\n'),/Small model\s+本地已安装/);
  terminal.input(down);terminal.input('\r');await model;assert.deepEqual(switched,['small']);
  const environment=ui.submit('/env');await delay();terminal.input(down);terminal.input('\r');await environment;
  assert.equal(c.environmentName,'web');assert.equal(c.newTaskTarget,'http://172.28.248.10:8000');
  const tab=ui.submit('/tab');await delay();terminal.input(down);terminal.input(down);terminal.input('\r');await tab;assert.equal(ui.tab,'budget');
  release();await new Promise(r=>setTimeout(r,0));assert.equal(ui.notice,'Ready');
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
  const feedback=ui.submit('/feedback c1');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/选择判题结果 · c1/);
  terminal.input(down);terminal.input(down);terminal.input('\r');await feedback;
  assert.equal(c.session('review').candidates()[0].feedback.status,'pending');
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
  c.models=async()=>[{id:'vision',number:1,name:'Vision',current:true,online:true}];
  const changingDevice=ui.submit('/model');await delay();terminal.input('\r');await delay();
  terminal.input(down);terminal.input('\r');await changingDevice;
  assert.deepEqual(choices,[['vision','cpu'],['vision','gpu'],['vision','gpu']]);
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('RAM KV slash settings work without a selected task, update admission policy and survive restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ram-kv-ui-'));let c,ui;
 const basePolicy={reserveMiB:3072,maxCacheMiB:4096,admissionSeconds:5};
 const cfg={contestDir:root,modelRuntime:{platform:'linux',ramKv:basePolicy}};
 const options={testMode:true,guard:()=>{throw Error('Configuration must not call the model');}};
 try{
  c=new Contest(cfg,options);const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();
  const menu=ui.submit('/offloadKV config');await delay();
  assert.match(ui.tui.getScreenLines().join('\n'),/系统内存余量\s+3072 MiB/);
  assert.match(ui.tui.getScreenLines().join('\n'),/CPU projector 额外余量\s+1280 MiB/);
  terminal.input('\r');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/输入 MiB 或 default/);
  for(const key of '4096')terminal.input(key);
  terminal.input('\r');await menu;assert.match(ui.detail,/reserveMiB = 4096 MiB/);
  await ui.submit('/offloadKV config reserveMiB=4096 cpuProjectorReserveMiB=1536 maxCacheMiB=6144');
  assert.match(ui.detail,/maxCacheMiB = 6144 MiB/);
  assert.deepEqual(c.catalog.config.modelRuntime.ramKv,{reserveMiB:4096,cpuProjectorReserveMiB:1536,maxCacheMiB:6144,admissionSeconds:5});
  await assert.rejects(ui.submit('/offloadKV config reserveMiB=512 maxCacheMiB=-1'),/非负整数/);
  await assert.rejects(ui.submit('/offloadKV config maxCacheMiB=9007199254740992'),/nonnegative integer/);
  await assert.rejects(ui.submit('/offloadKV config typo=4096'),/未知 RAM KV 配置项/);
  assert.equal(c.ramKvSettings().reserveMiB,4096);
  await ui.close();
  c=new Contest(cfg,options);ui=new CompetitionTerminal(c,{terminal:new Terminal()});
  assert.equal(c.ramKvSettings().maxCacheMiB,6144);
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
  const resume=ui.submit('/resume');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/选择要恢复的题目/);
  terminal.input(down);terminal.input('\r');await resume;assert.equal(ui.selected,'task-old-beta');
  assert.ok(!ui.sidebar.text.includes('task-old-'));
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('new-task wizard keeps drafts and recovers from missing or invalid attachment directories',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-wizard-retry-'));
 const attachments=path.join(root,'attachments with spaces');
 const missing=path.join(root,'missing');
 fs.mkdirSync(attachments);
 fs.mkdirSync(path.join(attachments,'nested','empty'),{recursive:true});
 fs.writeFileSync(path.join(attachments,'nested','sample.txt'),'sample');
 let c,ui,provisioned=0;
 const config={contestDir:path.join(root,'contest'),importLimits:{maxFiles:1}};
 const options={testMode:true,guard:()=>{throw Error('No inference');},provision:async id=>{
  provisioned++;
  const workDir=path.join(root,'work-'+id);
  fs.mkdirSync(workDir);
  return {containerId:id,workDir};
 },sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})};
 try{
  c=new Contest(config,options);
  ui=new CompetitionTerminal(c,{terminal:new Terminal()});
  ui.beginNew();
  await ui.submit('测试题');
  await ui.submit('第一行\n第二行');
  await assert.rejects(ui.submit(missing),/附件路径不可用/);
  assert.equal(ui.wizard.step,2);
  assert.equal(ui.editor.getExpandedText(),missing);
  assert.equal(provisioned,0);
  await ui.submit('/back');
  assert.equal(ui.editor.getExpandedText(),'第一行\n第二行');
  await ui.submit(ui.editor.getExpandedText());
  await ui.submit('"'+attachments+'"');
  assert.equal(ui.wizard.step,3);
  await ui.submit('back');
  assert.equal(ui.editor.getExpandedText(),'"'+attachments+'"');
  await ui.submit(ui.editor.getExpandedText());
  await assert.rejects(ui.submit('create'),/\/back 返回修改附件/);
  // An old saved draft may already be on step 4 with a broken path.
  ui.wizard.values.attachmentDir=missing;
  ui.persist();
  await ui.close();
  c=new Contest(config,options);
  ui=new CompetitionTerminal(c,{terminal:new Terminal()});
  await assert.rejects(ui.submit('-'),/附件路径不可用/);
  assert.equal(ui.wizard.step,2);
  assert.equal(ui.wizard.values.title,'测试题');
  assert.equal(ui.wizard.values.objective,'第一行\n第二行');
  assert.equal(provisioned,0);
  await ui.submit(attachments);
  fs.writeFileSync(path.join(attachments,'extra.txt'),'extra');
  await assert.rejects(ui.submit('-'),/Attachment import limit exceeded/);
  assert.equal(ui.wizard.step,2);
  assert.equal(provisioned,0);
  fs.unlinkSync(path.join(attachments,'extra.txt'));
  await ui.submit(attachments);
  await ui.submit('-');
  assert.equal(ui.wizard,null);
  assert.equal(provisioned,1);
  assert.deepEqual(c.records.get(ui.selected).task.input_files,['/work/attachments/nested/sample.txt']);
  const imported=c.records.get(ui.selected).config.sandbox.workDir;
  assert.ok(fs.statSync(path.join(imported,'attachments','nested','empty')).isDirectory());
  const singleFile=path.join(attachments,'nested','a file.txt');
  fs.writeFileSync(singleFile,'one attachment');
  await ui.submit('/new');
  await ui.submit('单文件');
  await ui.submit('只导入选中的文件');
  await ui.submit('"'+singleFile+'"');
  assert.equal(ui.wizard.step,3);
  await ui.submit('-');
  const single=c.records.get(ui.selected);
  assert.deepEqual(single.task.input_files,['/work/attachments/a file.txt']);
  assert.deepEqual(fs.readdirSync(path.join(single.config.sandbox.workDir,'attachments')),['a file.txt']);
  assert.equal(fs.readFileSync(path.join(single.config.sandbox.workDir,'attachments','a file.txt'),'utf8'),'one attachment');
  await ui.submit('/new');
  await ui.submit('/cancel');
  assert.equal(ui.wizard,null);
 }finally{await ui?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('/delete supports a direct task number and an interactive session picker',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-ui-'));let c,ui;const deleted=[];
 try{
  const provision=async id=>{const workDir=path.join(root,'work',id);fs.mkdirSync(workDir,{recursive:true});return {containerId:id.padEnd(64,'0'),workDir};};
  const deprovision=async(id,sandbox)=>{deleted.push([id,sandbox.containerId]);fs.rmSync(sandbox.workDir,{recursive:true});return {deleted:true};};
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{throw Error('No inference');},provision,deprovision,sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'alpha',title:'第一题',objective:'fixture'});await c.add({id:'beta',title:'第二题',objective:'fixture'});
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();
  await ui.submit('/delete 01');assert.equal(c.records.has('alpha'),false);assert.equal(ui.selected,'beta');assert.match(ui.notice,/已删除 01/);
  const choosing=ui.submit('/delete');await delay();assert.match(ui.tui.getScreenLines().join('\n'),/选择要删除的会话/);terminal.input('\r');await choosing;
  assert.equal(c.records.size,0);assert.equal(ui.selected,undefined);assert.deepEqual(deleted.map(x=>x[0]),['alpha','beta']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.root,'tasks.json'))),[]);
 }finally{await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('failed sandbox cleanup keeps the session and its queue state',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-failure-'));let c;
 try{
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:9'}},{testMode:true,guard:()=>{},provision:async id=>{const workDir=path.join(root,'work',id);fs.mkdirSync(workDir,{recursive:true});return {containerId:'a'.repeat(64),workDir};},deprovision:async()=>{throw Error('synthetic cleanup failure');},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'alpha',objective:'fixture'});const before=structuredClone(c.queue.item('alpha'));
  await assert.rejects(c.delete('alpha'),/synthetic cleanup failure/);
  assert.equal(c.records.has('alpha'),true);assert.deepEqual(c.queue.item('alpha'),before);assert.ok(fs.existsSync(c.records.get('alpha').config.sandbox.workDir));
 }finally{await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('/btw displays main and branch together, keeps drafts separate, and Ctrl+C only controls the branch',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-btw-ui-'));let c,ui,controller;const erased=[];
 try{
  const modelFetch=async(url,options={})=>{
   if(url.endsWith('/kv-cache'))return Response.json({schema_version:1,ctf_btw:{enabled:true,kv_unified:true,main_slot:0,branch_slot:1,required_free_cells:100},scheduler:{generating:1,prefill:0,retained_slots:1},slots:[{id:0},{id:1}],contexts:{target:{supported:true,pools:[{id:'p',kind:'attention',capacity_cells:1000,occupied_cells:200,free_cells:800,shared_cells:0,exclusive_cells:200,membership_groups:[{sequences:[0],cells:200}]}]}}});
   if(url.endsWith('/input_tokens'))return Response.json({input_tokens:50});
   if(url.endsWith('/slots/1?action=erase')){erased.push(1);return Response.json({id_slot:1,n_erased:1});}
   if(url.endsWith('/v1/chat/completions'))return new Response(new ReadableStream({start(stream){controller=stream;stream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'分支正在回答'},finish_reason:null}]})+'\n\n'));},cancel(){}}),{headers:{'content-type':'text/event-stream'}});
   return new Response('{}',{status:404});
  };
  c=new Contest({contestDir:path.join(root,'contest'),model:{baseUrl:'http://127.0.0.1:8080'}},{testMode:true,guard:()=>{},modelFetch,provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir);return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
  await c.add({id:'fixture',objective:'Investigate evidence'});const session=c.session('fixture');
  const body={model:session.config.model,messages:[{role:'system',content:'system'},{role:'user',content:'main evidence'}],tools:[]};
  session.store.append('model_request',{requestId:1,body,prompt_tokens:20});session.store.append('model_accepted',{requestId:1});
  const digest=session.store.events.at(-1).digest;
  const terminal=new Terminal();ui=new CompetitionTerminal(c,{terminal});ui.start();ui.editor.setText('主线草稿');
  ui.agentEvent({taskId:'fixture',event:{type:'message_update',message:{role:'assistant',content:[{type:'text',text:'主线正在推理'}]}}});
  await ui.submit('/btw');assert.equal(ui.btwFocused,true);assert.equal(ui.editor.getExpandedText(),'');
  await ui.submit('有没有遗漏');await delay();ui.renderNow();
  const screen=ui.tui.getScreenLines().join('\n');assert.match(screen,/主线正在推理/);assert.match(screen,/分支正在回答/);assert.match(screen,/输入绑定.*分支/);
  ui.interrupt();await c.btw.running;assert.equal(c.btw.status,'paused');assert.equal(session.store.events.at(-1).digest,digest);
  await ui.submit('/main');assert.equal(ui.btwFocused,false);assert.equal(ui.editor.getExpandedText(),'主线草稿');
  await ui.submit('/btw');ui.interrupt();await delay();assert.equal(c.btw,null);assert.deepEqual(erased,[1]);assert.equal(session.store.events.at(-1).digest,digest);
 }finally{if(controller)try{controller.close();}catch{}await ui?.close();await c?.close();fs.rmSync(root,{recursive:true,force:true});}
});
