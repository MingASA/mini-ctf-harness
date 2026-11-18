import fs from 'node:fs';
import path from 'node:path';
import {TuiAltScreen,ProcessTerminal,Editor,Text,VStack,HStack,ScrollView,SelectList,Container,matchesKey,CombinedAutocompleteProvider} from '@earendil-works/pi-tui';
import {outputRoot} from './tool-output.mjs';
import {sessionUsage,contextLine,usageLine,budgetText} from './session-usage.mjs';
import {safeText,toolResultText,transcriptText} from './transcript-display.mjs';
import {atomic} from './store.mjs';
import {projectorPlacement} from './model-catalog.mjs';
const plain=s=>s;
const selectTheme={selectedPrefix:plain,selectedText:s=>'\x1b[36m'+s+'\x1b[0m',description:plain,scrollInfo:plain,noMatch:plain};
const theme={borderColor:s=>'\x1b[36m'+s+'\x1b[0m',selectList:selectTheme};
export {safeText};
const stringify=v=>safeText(typeof v==='string'?v:JSON.stringify(v,null,2));
const HELP=`Ctrl+N 创建题目 · Ctrl+L 切换查看 · Ctrl+P 暂停当前题推理 · Ctrl+R 恢复 · Ctrl+C 中断生成并保留缓存
/start 启动调度   /queue 题目队列   /review 确认答案   /view [题号]   /priority 数值   /switch 题号（安全边界保存对话/KV并切题）
/env 查看或选择题目环境\n/model 查看模型 · /model 编号或ID 切换模型\n/compact 本轮结束后压缩 · /effort off|low|medium|high|xhigh [思考tokens|-1]\n/pause  /resume [题号]  /offloadKV 暂停并保存驻留题的 KV 到 RAM\n/offloadKV config [参数=MiB …] 查看或修改 RAM KV 余量及总上限\n/cancel 命令ID  /checkpoint  /feedback 候选ID correct|incorrect|pending 说明
/tab output|jobs|budget|files|inbox|candidates|compact  /tool 序号 查看工具输出  /read 文件路径  /archive 消息ID
/skills [检索词] 查看技能元数据 · /use-skill NAME 将读取请求加入本题消息队列\n/new 创建题目（题意可多行粘贴） /discard 清空当前草稿  /quit 保存退出
直接输入补充消息；Enter 发送，Shift+Enter 换行；已送达表示服务已接受包含该消息的请求。`;
export class CompetitionTerminal {
 constructor(contest,{terminal=new ProcessTerminal(),onClose=()=>{}}={}){
  this.contest=contest;this.onClose=onClose;this.tui=new TuiAltScreen(terminal,true,undefined,{mouse:true,copyOnSelect:false,openUrl:()=>{}});
  this.file=path.join(contest.root,'ui-state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};
  this.selected=contest.records.has(saved.selected)?saved.selected:contest.records.keys().next().value;this.drafts=saved.drafts||{};this.wizard=saved.wizard||null;this.bound=this.selected;this.tab='output';this.live=new Map();this.notice='';this.detail=null;
  this.header=new Text('',1,0);this.sidebar=new Text('',1,0);this.content=new Text('',1,0);this.footer=new Text('',1,0);this.binding=new Text('',1,0);
  this.editor=new Editor(this.tui,theme);this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(['start','queue','review','new','view','priority','switch','pause','resume','offloadKV','cancel','compact','effort','model','env','checkpoint','feedback','tab','tool','read','archive','help','skills','use-skill','discard','quit'].map(name=>({name,description:name})),contest.root));
  this.editor.onChange=()=>{if(!this.bound&&!this.wizard)this.bound=this.selected;this.persistDraft();this.render();};
  this.editor.onSubmit=text=>{if(this.submitting)return;this.submitting=true;this.editor.disableSubmit=true;this.submit(text).catch(e=>{this.notice=e.message;this.render();}).finally(()=>{this.submitting=false;this.editor.disableSubmit=false;});};
  this.scroll=new ScrollView(this.content,{follow:'end',primary:true,scrollbar:'auto'});
  this.tui.setLayoutRoot(new VStack([
   {component:this.header,basis:2,shrink:0},
   {component:new HStack([{component:new ScrollView(this.sidebar,{follow:'none'}),basis:30,minSize:16,maxSize:40},{component:this.scroll,grow:1,minSize:10}],{gap:1}),grow:1,minSize:3},
   {component:this.binding,basis:2,shrink:0},{component:this.editor,basis:'auto',maxSize:9,minSize:3,shrink:0},{component:this.footer,basis:2,shrink:0}
  ]));
  this.tui.setFocus(this.editor);
  this.tui.addInputListener(data=>{
   if(matchesKey(data,'ctrl+c')){this.interrupt();return {consume:true};}
   if(matchesKey(data,'ctrl+n')){this.beginNew();return {consume:true};}
   if(matchesKey(data,'ctrl+l')){this.chooseTask();return {consume:true};}
   if(matchesKey(data,'ctrl+p')){this.attempt(()=>contest.pause(this.requireTask()));return {consume:true};}
   if(matchesKey(data,'ctrl+r')){this.attempt(()=>{this.setView(this.requireTask());contest.resume(this.requireTask());});return {consume:true};}
  });
  this.changed=()=>this.render();this.agentEvent=({taskId,event})=>{
   if(event.type==='message_update')this.live.set(taskId,structuredClone(event.message));
   if(event.type==='message_end')this.live.delete(taskId);this.render();
  };
  this.auxiliaryEvent=({taskId,event})=>{if(taskId===this.selected&&event.kind==='compact'){this.notice=event.status==='idle'?'Compact 已结束；/tab compact 查看结果。':event.content!==undefined?'Compact 生成中 · '+event.reasoning.length+' 思考字符 / '+event.content.length+' 输出字符':'Compact 处理中…';this.render();}};
  contest.on('auxiliary',this.auxiliaryEvent);contest.on('change',this.changed);contest.on('agent',this.agentEvent);
  this.editor.setText(this.wizard?.draft||this.drafts[this.bound]||'');this.render();
 }
 interrupt(){this.persistDraft();this.contest.cancelInitialization?.();this.contest.interruptActive();this.notice='已请求中断；完整输出会保存，模型和 KV 保持驻留。输入消息或 /resume 继续。';this.render();}
 requireTask(){if(!this.selected)throw Error('先创建或选择题目');return this.selected;}
 attempt(fn){Promise.resolve().then(fn).catch(e=>{this.notice=e.message;this.render();});}
 persist(){atomic(this.file,{selected:this.selected,drafts:this.drafts,wizard:this.wizard});}
 persistDraft(){const text=this.editor.getExpandedText();if(this.wizard)this.wizard.draft=text;else if(this.bound)this.drafts[this.bound]=text;this.persist();}
 setView(id){id=this.contest.resolveTaskId(id);this.contest.session(id);this.selected=id;this.tab='output';this.detail=null;this.scroll.scrollToEnd();this.notice='正在查看 '+this.contest.taskLabel(id)+' · '+this.contest.taskTitle(id);if(!this.editor.getExpandedText()&&!this.wizard){this.bound=id;this.editor.setText(this.drafts[id]||'');}this.persist();this.render();}
 beginNew(){this.persistDraft();this.wizard={step:0,values:{},draft:''};this.editor.setText('');this.render();}
 async chooseTask(){const item=await this.select('切换查看（不打断推理）',[...this.contest.records.values()].map(r=>({value:r.task.id,label:safeText(this.contest.taskTitle(r.task.id)),description:this.contest.taskLabel(r.task.id)+' '+this.contest.status(r.task.id)})));if(item)this.setView(item.value);}
 select(title,items){return new Promise(resolve=>{
  const list=new SelectList(items,12,selectTheme),box=new Container();box.addChild(new Text(safeText(title),1,1));box.addChild(list);
  box.handleInput=data=>list.handleInput(data);const overlay=this.tui.showOverlay(box,{width:'80%',maxHeight:'80%'});
  const finish=item=>{overlay.hide();this.tui.setFocus(this.editor);resolve(item);};list.onSelect=finish;list.onCancel=()=>finish(null);this.tui.requestRender();
 });}
 async directory(start){let dir=path.resolve(start||process.cwd());while(true){
  const entries=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).sort((a,b)=>a.name.localeCompare(b.name));
  const selected=await this.select('附件目录 '+dir,[{value:'.',label:'选择当前目录'},{value:'..',label:'上一级'},...entries.map(e=>({value:e.name,label:safeText(e.name)+'/'}))]);
  if(!selected)return null;if(selected.value==='.')return dir;dir=path.resolve(dir,selected.value);
 }}
 async submit(text){
  if(text.trim()==='/quit'){await this.close();return;}
  if(this.wizard){await this.wizardSubmit(text);return;}
  if(!text.trim())return;
  if(text.startsWith('/')){
   const [cmd,...args]=text.trim().split(/\s+/);const id=this.selected;
   if(cmd==='/discard'){if(this.bound)delete this.drafts[this.bound];this.editor.setText('');this.bound=id;this.editor.setText(this.drafts[id]||'');this.render();return;}
   if(cmd==='/new'){this.beginNew();return;}
   if(cmd==='/quit'){await this.close();return;}
   if(cmd==='/help'){this.detail=HELP;}
   else if(cmd==='/skills'){
    const k=this.contest.session(this.requireTask()).knowledge;
    this.detail=stringify(args.length?k.search(args.join(' ')):k.docs.map(({name,description,filePath})=>({name,description,filePath})));
   }
   else if(cmd==='/use-skill'){
    const taskId=this.requireTask(),s=this.contest.session(taskId);if(s.config.mode!=='memory-skills')throw Error('当前题未启用技能工具');
    const name=args.join(' '),skill=s.knowledge.skill(name);
    const item=this.contest.enqueue(taskId,'Use read to load '+JSON.stringify(skill.filePath)+'. Resolve needed reference paths relative to its directory.');
    this.notice=`技能读取请求已排队 → ${this.contest.taskLabel(taskId)} · ${item.id}`;
   }
   else if(cmd==='/start'){this.contest.start();this.notice='调度已开启；/queue 查看队列，/review 记录人工判题结果。';}
   else if(cmd==='/queue'){this.tab='queue';this.detail=null;}
   else if(cmd==='/review')await this.review();
   else if(cmd==='/view'){if(args.length>1)throw Error('用法：/view [题号]');if(args[0])this.setView(args[0]);else await this.chooseTask();}
   else if(cmd==='/priority')this.contest.priority(this.requireTask(),Number(args[0]));
   else if(cmd==='/switch'){const target=args[0]?this.contest.resolveTaskId(args[0]):this.requireTask();this.setView(target);this.contest.switchInference(target);}
   else if(cmd==='/pause')this.contest.pause(this.requireTask());
   else if(cmd==='/resume'){if(args.length>1)throw Error('用法：/resume [题号]');if(args[0])this.setView(args[0]);else this.setView(this.requireTask());this.contest.resume(this.requireTask());}
   else if(cmd==='/offloadKV'){
    if(args[0]==='config')this.configureRamKv(args.slice(1));
    else{
     if(args.length)throw Error('用法：/offloadKV 或 /offloadKV config [参数=MiB …]');
     this.notice='正在暂停并检查 RAM KV…';this.render();
     const result=await this.contest.offloadKV(this.requireTask());
     this.notice=result.status==='saved'
      ?`已保存 ${result.receipt.n_saved} tokens 的 KV（${(result.receipt.n_written/1024**2).toFixed(0)} MiB）。用 /resume 题号 继续。`
      :'已暂停并保留对话。RAM KV 未保存：'+result.reason;
    }
   }
   else if(cmd==='/env'){if(args.length>1)throw Error('用法：/env [环境名称]');const environments=this.contest.config.environments??{};if(args.length){if(!environments[args[0]])throw Error('未知环境');this.contest.environmentName=args[0];this.contest.newTaskTarget=environments[args[0]].targetUrl??'';this.notice='新题环境已设为 '+args[0];}else this.detail=Object.entries(environments).map(([name,e])=>`${name===this.contest.environmentName?'▶ ':''}${name} · ${e.type} · ${e.targetUrl??''}`).join('\n')+'\n/env 环境名称：用于之后创建的题目。';}
   else if(cmd==='/model'){
    if(args.length>2)throw Error('用法：/model [编号或ID] [cpu|gpu]');
    if(args.length){
     const [value,device]=args;
     let projectorDevice=device;
     if(!projectorDevice){
      const {profile,current}=this.contest.modelProfile(id,value);
      if(projectorPlacement(profile,current)){
       const choice=await this.select('视觉 projector 放置位置',[
        {label:'CPU · 使用系统内存',value:'cpu'},
        {label:'GPU · 使用显存',value:'gpu'},
       ]);
       if(!choice)return;
       projectorDevice=choice.value;
      }
     }
     this.notice='正在切换模型…';this.render();
     this.contest.switchModel(id,value,{projectorDevice}).then(()=>{this.notice=this.contest.notice;this.detail=null;this.render();})
      .catch(error=>{this.notice='模型切换未完成：'+error.message;this.render();});
    }else{
     const models=await this.contest.models(id);
     this.detail=models.map(m=>`${m.current?'▶ ':'  '}${m.number}. ${m.name} (${m.id})\n${m.online?'服务在线':m.managed&&m.installed?'本地已安装，可加载':'服务未就绪'} · ${m.baseUrl}`).join('\n\n')+
      '\n\n/model 编号或ID [cpu|gpu] 切换；视觉型号可选择 projector 的放置位置。';
    }
   }
   else if(cmd==='/compact'){this.contest.compact(this.requireTask());this.notice='Compact 已排队，将在完整轮次边界执行。';}
   else if(cmd==='/effort'){if(args.length>2)throw Error('用法：/effort 强度 [思考tokens|-1]');this.detail=stringify(this.contest.effort(this.requireTask(),args[0],args[1]));this.notice='思考设置将在下一次模型请求前生效；/effort 查看设置。';}
   else if(cmd==='/cancel')await this.contest.cancel(this.requireTask(),args[0]);
   else if(cmd==='/checkpoint')await this.contest.checkpoint(this.requireTask());
   else if(cmd==='/feedback')this.contest.feedback(this.requireTask(),args[0],args[1],args.slice(2).join(' '));
   else if(cmd==='/tab'){if(!['output','jobs','budget','files','inbox','candidates','compact','queue'].includes(args[0]))throw Error('未知面板');this.tab=args[0];this.detail=null;if(this.tab==='output')this.scroll.scrollToEnd();}
   else if(cmd==='/tool'){
    if(args.length!==1||!/^[1-9]\d*$/.test(args[0]))throw Error('用法：/tool 序号');
    const result=this.contest.session(this.requireTask()).messages().filter(m=>m.role==='toolResult')[Number(args[0])-1];
    if(!result)throw Error('当前题没有这个工具结果');
    this.detail=`[工具结果 ${args[0]} · ${result.toolName??'工具'}]\n/tab output 返回对话\n\n`+toolResultText(result);
    this.scroll.scrollTo(0,{disableFollow:true});
   }
   else if(cmd==='/read')this.detail=(await this.contest.session(this.requireTask()).tools().find(t=>t.name==='read').execute('operator-read-'+Date.now(),{path:args[0]})).content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
   else if(cmd==='/archive')this.contest.session(this.requireTask()).inbox.retire(args[0]);
   else throw Error('未知命令；/help 查看帮助');
  }else{
   const id=this.bound||this.requireTask();const item=this.contest.enqueue(id,text);this.notice=`已排队 → ${this.contest.taskLabel(id)} · ${item.id}`;
  }
  if(this.bound)delete this.drafts[this.bound];this.editor.setText('');this.bound=this.selected;this.editor.setText(this.drafts[this.bound]||'');this.persist();this.render();
 }
 configureRamKv(args){
  const updates=Object.fromEntries(args.map(arg=>{
   const match=/^([^=]+)=(default|\d+)$/.exec(arg);
   if(!match)throw Error('用法：/offloadKV config 参数=非负整数MiB 或 参数=default');
   const [,name,value]=match;
   return [name,value==='default'?undefined:Number(value)];
  }));
  const {enabled,reserveMiB,cpuProjectorReserveMiB,maxCacheMiB}=this.contest.ramKvSettings(args.length?updates:undefined);
  this.detail=[
   enabled?'RAM KV 已配置启用':'RAM KV 待启用 · 在 modelRuntime.ramKv 配置后重启托管引擎',
   `reserveMiB = ${reserveMiB} MiB · 系统内存余量`,
   `cpuProjectorReserveMiB = ${cpuProjectorReserveMiB} MiB · CPU projector 额外余量`,
   `maxCacheMiB = ${maxCacheMiB===undefined?'随可用内存变化':maxCacheMiB+' MiB'} · 快照总上限`,
   '',
   '/offloadKV config reserveMiB=4096 cpuProjectorReserveMiB=1536 maxCacheMiB=6144',
   '参数=default 恢复该项的配置文件值或内置默认值。'
  ].join('\n');
  if(args.length)this.notice=enabled?'RAM KV 设置已保存，下次 KV 操作生效。':'RAM KV 设置已保存，启用后生效。';
 }
 async review(){
  const candidates=this.contest.queueRows().flatMap(row=>row.reviews.map(candidate=>({value:row.id+':'+candidate.review_id,taskId:row.id,candidate,label:row.title+' · '+candidate.review_id,description:candidate.candidate})));
  if(!candidates.length){this.notice='暂无待人工确认的答案。';return;}
  const item=await this.select('选择待确认答案',candidates);if(!item)return;
  const verdict=await this.select('平台判题结果 · '+item.candidate.candidate,[{value:'correct',label:'通过'},{value:'incorrect',label:'错误'}]);
  if(!verdict)return;this.contest.feedback(item.taskId,item.candidate.review_id,verdict.value);this.setView(item.taskId);this.notice='已记录 '+this.contest.taskLabel(item.taskId)+' 的判题结果。';
 }
 async wizardSubmit(text){
  if(text==='/back'){this.wizard=null;this.editor.setText(this.drafts[this.bound]||'');this.persist();this.render();return;}
  const w=this.wizard,keys=['title','objective','attachmentDir','target'];let value=text.trim();
  if(w.step===2&&value.startsWith('/browse')){value=await this.directory(value.slice(7).trim());if(value===null)return;}
  if(w.step<2&&!value)throw Error('此项不能为空');if(w.step>=2&&value==='-')value='';
  w.values[keys[w.step]]=value;
  if(w.step===3){this.notice='正在创建独立题目与附件快照…';this.render();const record=await this.contest.add(w.values);this.wizard=null;this.selected=record.task.id;this.bound=this.selected;this.tab='output';this.detail=null;this.notice='题目已创建，进入首次启动队列。/start 启动调度';}
  else w.step++;
  this.editor.setText(this.wizard?.step===3?(this.contest.newTaskTarget??''):'');this.persist();this.render();
 }
 render(){
  if(this.renderTimer||this.closed)return;
  this.renderTimer=setTimeout(()=>{this.renderTimer=null;if(!this.closed)this.renderNow();},25);
 }
 renderNow(){
  const c=this.contest,s=this.selected?c.sessions.get(this.selected):null;
  this.header.setText(safeText(`CTF 比赛终端 · ${c.source?.commit?.slice(0,8)??'未知版本'}${c.source?.dirty?'*':''} · ${c.booting?'准备中':c.enabled?'调度开启':'调度停止'} · 模型 ${s?.config.model??c.defaultModel?.model??'未选择'} · 环境 ${c.environmentName??'默认'}\n推理 ${c.taskLabel(c.active)||'空闲'} · 查看 ${c.taskLabel(this.selected)||'无'} · 恢复 ${c.queue.state.readyResume.length} | 新题 ${c.queue.state.readyFresh.length} | 工具等待 ${Object.keys(c.queue.state.waiting).length} | 待确认 ${c.queueRows().reduce((n,r)=>n+r.reviews.length,0)} · /queue`));
  this.sidebar.setText([...c.records.values()].map(r=>`${r.task.id===this.selected?'▶':' '} ${c.taskTitle(r.task.id)}\n${c.taskLabel(r.task.id)}\n${c.status(r.task.id)} · 优先级 ${c.queue.item(r.task.id)?.priority??0}`).map(safeText).join('\n\n')||'Ctrl+N 创建第一题');
  let content=this.detail;
  if(content===null){
   if(this.tab==='queue')content='题目 | 状态 | 模型 | 后台任务 | 待确认答案\n'+c.queueRows().map(r=>`${r.title} (${c.taskLabel(r.id)}) | ${r.status==='awaiting_review'?'待人工确认':r.status} | ${r.model} | ${r.jobs} | ${r.reviews.map(x=>x.review_id+': '+x.candidate).join(', ')||'—'}`).join('\n\n')+'\n\n/review：选择答案并记录通过或错误；/view [题号]：查看对话。';
   else if(!s)content=HELP;
   else if(this.tab==='output'){
    this.content.setText(transcriptText(s.messages(),this.live.get(this.selected),{useColor:!process.env.NO_COLOR}));
   }else if(this.tab==='jobs')content=s.store.events.filter(e=>e.type==='job_launch_attempt').map(e=>{const id=e.data.job_id,last=s.store.events.findLast(x=>x.type==='job_output_cursor'&&x.data.job_id===id);const dep=s.dependencies().some(x=>x.id===id);return `${id} · ${dep?'运行中':'已结束'} · ${last?'已有输出':'等待输出'}`;}).join('\n')||'暂无后台命令';
   else if(this.tab==='budget')content=budgetText(s);
   else if(this.tab==='files'){const dir=outputRoot(s.store,s.broker);content=fs.existsSync(dir)?fs.readdirSync(dir).map(f=>'/read /work/.tool-output/'+f).join('\n'):'暂无保存的长输出';}
   else if(this.tab==='inbox')content=s.inbox.items().map(i=>`${i.status==='queued'?'已排队':'已送达'}${i.retired?' · 已归档':''} → ${c.taskLabel(i.taskId)} · ${i.id}\n${i.text}`).join('\n\n')||'尚无补充消息';
   else if(this.tab==='candidates')content=s.candidates().map(x=>`${x.review_id} · ${x.candidate}\n${x.feedback?.status??'待人工确认'} · /review`).join('\n\n')||'暂无候选答案';
   else content=stringify({pending:s.pendingControl('compact')?.seq??null,lastResult:s.store.events.findLast(e=>e.type==='compact_resolved')?.data,summary:s.store.events.findLast(e=>e.type==='compact_commit')?.data.checkpoint?.summary??'尚无 Compact 摘要',partial:s.store.events.findLast(e=>e.type==='model_auxiliary_interrupted')?.data});
  }
  if(content!==null)this.content.setText(safeText(content).slice(-160000));
  const usage=s?sessionUsage(s.store,s.config):null;
  this.binding.setText(safeText(this.wizard?`创建 ${this.wizard.step+1}/4：${['题目标题','粘贴题意（支持多行）','附件目录：路径 /browse 或 - 跳过','内网目标 URL 或 - 跳过'][this.wizard.step]} · /back 取消`:`输入绑定 → ${c.taskLabel(this.bound||this.selected)||'无题目'} · 面板 ${this.tab}${usage?' · '+usageLine(usage)+'\n'+contextLine(usage):''}`));
  this.footer.setText(safeText((this.notice||c.notice||'Ctrl+C 中断生成 · Ctrl+R 恢复 · /compact 压缩 · /effort 调整思考 · /quit 退出')+'\n'+(c.notice&&this.notice?c.notice:'暂停推理保留命令运行；/cancel 命令ID 单独取消。')));
  this.tui.requestRender();
 }
 start(){this.tui.start();this.render();}
 async close(){if(this.closed)return;this.closed=true;this.persistDraft();this.notice='正在保存并停止推理…';this.render();try{await this.contest.close();}finally{this.contest.off('auxiliary',this.auxiliaryEvent);this.contest.off('change',this.changed);this.contest.off('agent',this.agentEvent);clearTimeout(this.renderTimer);this.tui.stop();this.onClose();}}
}
