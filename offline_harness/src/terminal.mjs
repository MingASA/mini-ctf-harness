import fs from 'node:fs';
import path from 'node:path';
import {TuiAltScreen,ProcessTerminal,Editor,Input,Text,VStack,HStack,ScrollView,SelectList,Container,matchesKey,CombinedAutocompleteProvider} from '@earendil-works/pi-tui';
import {outputRoot} from './tool-output.mjs';
import {sessionUsage,contextLine,usageLine,budgetText} from './session-usage.mjs';
import {windowSettings} from './session-window.mjs';
import {safeText,toolResultText,transcriptText} from './transcript-display.mjs';
import {atomic} from './store.mjs';
import {AttachmentInputError,resolveAttachmentPath} from './contest.mjs';
import {projectorPlacement} from './model-catalog.mjs';
import {slashCommands,effortOptions,effortBudgetOptions,budgetLabel,panelOptions,verdictOptions} from './terminal-options.mjs';
const wizardFields=['title','objective','attachmentDir','target'];
const plain=s=>s;
const selectTheme={selectedPrefix:plain,selectedText:s=>'\x1b[36m'+s+'\x1b[0m',description:plain,scrollInfo:plain,noMatch:plain};
const theme={borderColor:s=>'\x1b[36m'+s+'\x1b[0m',selectList:selectTheme};
export {safeText};
const stringify=v=>safeText(typeof v==='string'?v:JSON.stringify(v,null,2));
const HELP=`Ctrl+N 创建题目 · Ctrl+L 切换查看 · Ctrl+P 暂停当前题推理 · Ctrl+R 恢复 · Ctrl+C 中断生成并保留缓存
/start 启动调度   /queue 题目队列   /review 确认答案   /view [题号]   /delete [题号]   /priority [数值]   /switch [题号]（保存进度并切题）
/env [环境] 选择新题环境\n/model [编号或ID] 选择模型\n/compact 本轮结束后压缩 · /effort [normal|compact] [强度] [思考tokens|-1] 选择思考设置\n/pause  /resume [题号]  /offloadKV 暂停并保存驻留题的 KV 到 RAM\n/offloadKV config [参数=MiB …] 查看或修改 RAM KV 余量及总上限\n/cancel 命令ID  /checkpoint  /feedback 候选ID correct|incorrect|pending 说明
/context [窗口 软压缩线] 调整当前会话，例如 /context 64K 48K
/tab [面板]  /tool 序号 查看工具输出  /read 文件路径  /archive 消息ID
/skills [检索词] 查看技能元数据 · /use-skill NAME 将读取请求加入本题消息队列\n/new 创建题目（题意可多行粘贴） /discard 清空当前草稿  /quit 保存退出
直接输入补充消息；Enter 发送，Shift+Enter 换行；已送达表示服务已接受包含该消息的请求。`;
export class CompetitionTerminal {
 constructor(contest,{terminal=new ProcessTerminal(),onClose=()=>{}}={}){
  this.contest=contest;this.onClose=onClose;this.tui=new TuiAltScreen(terminal,true,undefined,{mouse:true,copyOnSelect:false,openUrl:()=>{}});
  this.file=path.join(contest.root,'ui-state.json');const saved=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)):{};
  this.selected=contest.records.has(saved.selected)?saved.selected:contest.records.keys().next().value;this.drafts=saved.drafts||{};this.wizard=saved.wizard||null;this.bound=this.selected;this.tab='output';this.live=new Map();this.notice='';this.detail=null;
  this.header=new Text('',1,0);this.sidebar=new Text('',1,0);this.content=new Text('',1,0);this.footer=new Text('',1,0);this.binding=new Text('',1,0);
  this.editor=new Editor(this.tui,theme);this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands,contest.root));
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
   if(matchesKey(data,'ctrl+l')){this.attempt(()=>this.chooseTask());return {consume:true};}
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
 async chooseTask(){const id=await this.pickTask('选择要查看的题目');if(id)this.setView(id);}
 async pickTask(title){
  const items=[...this.contest.records.keys()].map(id=>({value:id,label:safeText(this.contest.taskLabel(id)+' · '+this.contest.taskTitle(id)),description:this.contest.status(id)}));
  if(!items.length)throw Error('先创建题目');
  return (await this.select(title,items,this.selected))?.value;
 }
 dialog(title,component,footer){
  const box=new Container();box.addChild(new Text(safeText(title),1,1));box.addChild(component);
  if(footer)box.addChild(footer);
  box.handleInput=data=>component.handleInput(data);
  const overlay=this.tui.showOverlay(box,{width:'80%',maxHeight:'80%'});
  return ()=>{overlay.hide();this.tui.setFocus(this.editor);};
 }
 select(title,items,current){return new Promise(resolve=>{
  const list=new SelectList(items,12,selectTheme);
  const currentIndex=items.findIndex(item=>item.value===current);
  if(currentIndex>=0)list.setSelectedIndex(currentIndex);
  const close=this.dialog(title,list);
  list.onSelect=item=>{close();resolve(item);};list.onCancel=()=>{close();resolve(null);};
 });}
 inputValue(title,placeholder,validate){return new Promise(resolve=>{
  const input=new Input({prompt:'› ',placeholder}),error=new Text('Enter 确认 · Esc 取消',1,0);
  input.focused=true;
  const close=this.dialog(title,input,error);
  input.onSubmit=raw=>{
   const value=raw.trim(),message=validate(value);
   if(message){error.setText(message);return;}
   close();resolve(value);
  };
  input.onEscape=()=>{close();resolve(undefined);};
 });}
 async browseAttachment(start){
  const {resolved,info}=resolveAttachmentPath(start||process.cwd());
  if(info.isFile())return resolved;
  let dir=resolved;
  while(true){
   const entries=fs.readdirSync(dir,{withFileTypes:true})
    .filter(e=>e.isDirectory()||e.isFile())
    .sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
   const selected=await this.select('选择附件 · '+dir,[
    {value:'.',label:'导入当前目录'},
    {value:'..',label:'上一级'},
    ...entries.map(e=>({value:e.name,label:safeText(e.name)+(e.isDirectory()?'/':'')})),
   ]);
   if(!selected)return null;
   if(selected.value==='.')return dir;
   const next=resolveAttachmentPath(path.join(dir,selected.value));
   if(next.info.isFile())return next.resolved;
   dir=next.resolved;
  }
 }
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
   else if(cmd==='/delete'){
    if(args.length>1)throw Error('用法：/delete [题号]');
    const target=args[0]??await this.pickTask('选择要删除的会话');
    if(target){
     const resolved=this.contest.resolveTaskId(target),label=this.contest.taskLabel(resolved),title=this.contest.taskTitle(resolved);
     await this.contest.delete(resolved);delete this.drafts[resolved];this.live.delete(resolved);
     if(this.bound===resolved){this.bound=undefined;this.editor.setText('');}
     if(this.selected===resolved){this.selected=this.contest.records.keys().next().value;this.bound=this.selected;this.editor.setText(this.drafts[this.selected]||'');}
     this.tab='output';this.detail=null;this.notice='已删除 '+label+' · '+title;this.persist();
    }
   }
   else if(cmd==='/priority'){
    if(args.length>1)throw Error('用法：/priority [数值]');
    const task=this.requireTask(),current=this.contest.queue.item(task)?.priority??0;
    const value=args[0]??await this.inputValue('调整队列优先级 · 当前 '+current,'输入 -1000 到 1000',
     input=>/^-?\d+$/.test(input)&&Math.abs(Number(input))<=1000?null:'请输入 -1000 到 1000 之间的整数。');
    if(value!==undefined){this.contest.priority(task,Number(value));this.notice='优先级已设为 '+Number(value);}
   }
   else if(cmd==='/switch'||cmd==='/resume'){
    if(args.length>1)throw Error('用法：'+cmd+' [题号]');
    const target=args[0]??await this.pickTask(cmd==='/switch'?'选择要切换到的推理题目':'选择要恢复的题目');
    if(target){this.setView(target);if(cmd==='/switch')this.contest.switchInference(this.selected);else this.contest.resume(this.selected);}
   }
   else if(cmd==='/pause')this.contest.pause(this.requireTask());
   else if(cmd==='/offloadKV'){
    if(args[0]==='config')await this.configureRamKv(args.slice(1));
    else{
     if(args.length)throw Error('用法：/offloadKV 或 /offloadKV config [参数=MiB …]');
     this.notice='正在暂停并检查 RAM KV…';this.render();
     const result=await this.contest.offloadKV(this.requireTask());
     this.notice=result.status==='saved'
      ?`已保存 ${result.receipt.n_saved} tokens 的 KV（${(result.receipt.n_written/1024**2).toFixed(0)} MiB）。用 /resume 题号 继续。`
      :'已暂停并保留对话。RAM KV 未保存：'+result.reason;
    }
   }
   else if(cmd==='/env')await this.chooseEnvironment(args);
   else if(cmd==='/model'){
    if(args.length>2)throw Error('用法：/model [编号或ID] [cpu|gpu]');
    const choice=args.length?null:await this.chooseModel(id);
    const value=args[0]??choice?.value;
    if(!value)return;
    let projectorDevice=args[1];
    if(!projectorDevice){
     const {profile,current}=this.contest.modelProfile(id,value);
     const placement=projectorPlacement(profile,current);
     if(placement){
      const device=await this.select('视觉 projector 放置位置',[
       {label:'CPU · 使用系统内存',value:'cpu'},
       {label:'GPU · 使用显存',value:'gpu'},
      ],placement);
      if(!device)return;
      projectorDevice=device.value;
     }
     if(choice?.active&&(!placement||projectorDevice===placement))return;
    }
    this.notice='正在切换模型…';this.render();
    this.contest.switchModel(id,value,{projectorDevice}).then(()=>{this.notice=this.contest.notice;this.detail=null;this.render();})
     .catch(error=>{this.notice='模型切换未完成：'+error.message;this.render();});
   }
   else if(cmd==='/compact'){this.contest.compact(this.requireTask());this.notice='Compact 已排队，将在完整轮次边界执行。';}
   else if(cmd==='/context')await this.chooseContext(this.requireTask(),args);
   else if(cmd==='/effort')await this.chooseEffort(this.requireTask(),args);
   else if(cmd==='/cancel'){
    if(args.length>1)throw Error('用法：/cancel [命令ID]');
    const task=this.requireTask(),jobs=this.contest.session(task).dependencies().filter(job=>job.kind==='command');
    if(!args[0]&&!jobs.length)throw Error('当前题没有可取消的后台命令');
    const job=args[0]??(await this.select('选择要取消的后台命令',jobs.map(({id})=>({value:id,label:safeText(id)}))))?.value;
    if(job)await this.contest.cancel(task,job);
   }
   else if(cmd==='/checkpoint')await this.contest.checkpoint(this.requireTask());
   else if(cmd==='/feedback')await this.chooseFeedback(this.requireTask(),args);
   else if(cmd==='/tab')await this.choosePanel(args);
   else if(cmd==='/tool')await this.chooseToolResult(this.requireTask(),args);
   else if(cmd==='/read'){
    const task=this.requireTask();
    const file=args.length?args.join(' '):await this.inputValue('读取当前题文件','输入文件路径',value=>value?null:'请输入文件路径。');
    if(file)this.detail=(await this.contest.session(task).tools().find(t=>t.name==='read').execute('operator-read-'+Date.now(),{path:file})).content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
   }
   else if(cmd==='/archive'){
    if(args.length>1)throw Error('用法：/archive [消息ID]');
    const inbox=this.contest.session(this.requireTask()).inbox;
    const notes=inbox.items().filter(item=>item.status==='delivered'&&!item.retired);
    if(!args[0]&&!notes.length)throw Error('当前题没有可归档的补充消息');
    const note=args[0]??(await this.select('选择要归档的消息',notes.map(item=>({
     value:item.id,label:safeText(item.text.slice(0,100)),description:safeText(item.id),
    }))))?.value;
    if(note)inbox.retire(note);
   }
   else throw Error('未知命令；/help 查看帮助');
  }else{
   const id=this.bound||this.requireTask();const item=this.contest.enqueue(id,text);this.notice=`已排队 → ${this.contest.taskLabel(id)} · ${item.id}`;
  }
  if(this.bound)delete this.drafts[this.bound];this.editor.setText('');this.bound=this.selected;this.editor.setText(this.drafts[this.bound]||'');this.persist();this.render();
 }
 async chooseContext(id,args){
  const session=this.contest.session(id);
  if(!args.length){
   const usage=sessionUsage(session.store,session.config,session.sessionWindow);
   const title=`会话窗口 ${usage.total} · 软线 ${usage.soft} · 后端容量 ${session.config.contextTokens}`;
   const raw=await this.inputValue(title,'输入窗口和软线，例如 64K 48K',value=>{
    const fields=value.split(/\s+/);
    if(fields.length!==2)return '请输入窗口和软压缩线两个数值';
    try{windowSettings(session.config,...fields);return null;}catch(error){return error.message;}
   });
   if(raw===undefined)return;
   args=raw.split(/\s+/);
  }
  if(args.length!==2)throw Error('用法：/context [窗口 软压缩线]，例如 /context 64K 48K');
  const result=session.requestWindow(...args);
  this.tab='budget';this.detail=null;
  this.notice=result.pending?'已保存请求，将在下一次轮次边界校验并应用':'已保存当前会话的窗口和软压缩线';
 }
 async chooseEffort(id,args){
  let scope='normal';
  if(!args.length){
   const options=[{value:'normal',label:'正常推理'},{value:'compact',label:'Compact 压缩'}];
   for(const item of options){
    const {current,pending}=this.contest.session(id).generationControls(item.value);
    item.description=current.thinking?current.reasoningEffort:'关闭';
    if(pending)item.description+=' · 待生效 '+(pending.thinking?pending.reasoningEffort:'关闭');
   }
   const choice=await this.select('选择要调整的思考设置',options,'normal');
   if(!choice)return;
   scope=choice.value;
  }else if(['normal','compact'].includes(args[0]))[scope,...args]=args;
  if(args.length>2)throw Error('用法：/effort [normal|compact] [off|low|medium|high|xhigh] [思考tokens|-1]');
  const label=scope==='compact'?'Compact 压缩':'正常推理';
  let [level,budget]=args;
  if(!level){
   const {current,pending,limit}=this.contest.session(id).generationControls(scope);
   const selected=pending??current;
   const describe=settings=>settings.thinking?settings.reasoningEffort+' · '+budgetLabel(settings.reasoningTokens):'off';
   const choice=await this.select(label+'思考模式 · 当前 '+describe(current)+(pending?' · 待生效 '+describe(pending):''),
    effortOptions,selected.thinking?selected.reasoningEffort:'off');
   if(!choice)return;
   level=choice.value;
   if(level!=='off'){
    const preset=await this.select('思考预算 · '+level,effortBudgetOptions(selected.reasoningTokens,limit));
    if(!preset)return;
    if(preset.value==='custom'){
     budget=await this.inputValue('自定义思考预算','1–'+(limit-1)+' tokens，或 -1',
      value=>value==='-1'||(/^[1-9]\d*$/.test(value)&&Number(value)<limit)?null:'请输入小于 '+limit+' 的正整数，或 -1。');
     if(budget===undefined)return;
    }else if(preset.value!=='keep')budget=preset.value;
   }
  }
  const {settings,pending}=this.contest.effort(id,level,budget,scope);
  const summary=settings.thinking?settings.reasoningEffort+' · '+budgetLabel(settings.reasoningTokens):'关闭';
  this.tab='output';this.detail=null;this.scroll.scrollToEnd();
  this.notice=label+'思考 '+summary+(pending?' · 下一轮生效':' · 已保存');
 }
 async chooseModel(id){
  const models=await this.contest.models(id);
  if(!models.length)throw Error('暂无可选模型');
  const settings=id?this.contest.session(id).config:this.contest.defaultModel;
  const current=settings.modelSelection??models.find(m=>m.current)?.id;
  return this.select('选择模型 · 切换会暂停当前推理',models.map(m=>({
   value:m.id,label:safeText(m.number+'. '+m.name),active:m.id===current&&m.online,
   description:safeText([m.id===current?'当前模型':null,m.online?'服务在线':m.managed&&m.installed?'本地已安装，可加载':'服务未就绪',m.id].filter(Boolean).join(' · ')),
  })),current);
 }
 async chooseEnvironment(args){
  if(args.length>1)throw Error('用法：/env [环境名称]');
  const environments=this.contest.config.environments??{};
  let name=args[0];
  if(!name){
   const options=Object.entries(environments).map(([value,env])=>({
    value,label:safeText(value),description:safeText([env.type,env.targetUrl].filter(Boolean).join(' · ')),
   }));
   if(!options.length)throw Error('暂无已配置环境');
   name=(await this.select('选择环境 · 用于新建题目',options,this.contest.environmentName))?.value;
   if(!name)return;
  }
  if(!Object.hasOwn(environments,name))throw Error('未知环境');
  this.contest.environmentName=name;
  this.contest.newTaskTarget=environments[name].targetUrl??'';
  this.notice='新题环境已设为 '+name;
 }
 async choosePanel(args){
  if(args.length>1)throw Error('用法：/tab [面板]');
  const pane=args[0]??(await this.select('选择面板',panelOptions,this.tab))?.value;
  if(!pane)return;
  if(!panelOptions.some(option=>option.value===pane))throw Error('未知面板');
  this.tab=pane;this.detail=null;
  if(pane==='output')this.scroll.scrollToEnd();
 }
 async chooseFeedback(id,args){
  let [candidate,status]=args;
  if(!candidate){
   const options=this.contest.session(id).candidates().filter(item=>!item.feedback||item.feedback.status==='pending').map(item=>({
    value:item.review_id,label:safeText(item.review_id),description:safeText(item.candidate),
   }));
   if(!options.length)throw Error('当前题没有待确认的候选答案');
   candidate=(await this.select('选择候选答案',options))?.value;
   if(!candidate)return;
  }
  status??=(await this.select('选择判题结果 · '+candidate,verdictOptions))?.value;
  if(status)this.contest.feedback(id,candidate,status,args.slice(2).join(' '));
 }
 async chooseToolResult(id,args){
  if(args.length>1||args[0]&&!/^[1-9]\d*$/.test(args[0]))throw Error('用法：/tool [序号]');
  const results=this.contest.session(id).messages().filter(m=>m.role==='toolResult');
  if(!results.length)throw Error('当前题没有工具结果');
  const index=args[0]??(await this.select('选择工具结果',results.map((result,i)=>({
   value:String(i+1),label:safeText((i+1)+' · '+(result.toolName??'工具')),
  })).reverse()))?.value;
  if(!index)return;
  const result=results[Number(index)-1];
  if(!result)throw Error('当前题没有这个工具结果');
  this.detail=`[工具结果 ${index} · ${result.toolName??'工具'}]\n/tab output 返回对话\n\n`+toolResultText(result);
  this.scroll.scrollTo(0,{disableFollow:true});
 }
 async configureRamKv(args){
  const fields={reserveMiB:'系统内存余量',cpuProjectorReserveMiB:'CPU projector 额外余量',maxCacheMiB:'快照总上限'};
  if(!args.length||args.length===1&&Object.hasOwn(fields,args[0])){
   const current=this.contest.ramKvSettings();
   const field=args[0]??(await this.select('RAM KV 设置',Object.entries(fields).map(([value,label])=>({
    value,label,description:current[value]===undefined?'随可用内存变化':current[value]+' MiB',
   }))))?.value;
   if(!field)return;
   const value=await this.inputValue(fields[field],'输入 MiB 或 default',
    input=>input==='default'||(/^\d+$/.test(input)&&Number.isSafeInteger(Number(input)))?null:'请输入非负整数 MiB，或 default。');
   if(value===undefined)return;
   args=[field+'='+value];
  }
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
 setWizardStep(step){
  const w=this.wizard;
  w.step=step;
  w.draft=w.values[wizardFields[step]]??(step===3?(this.contest.newTaskTarget??''):'');
  this.editor.setText(w.draft);
  this.persist();
  this.render();
 }
 cancelWizard(){
  this.wizard=null;
  this.editor.setText(this.drafts[this.bound]||'');
  this.persist();
  this.render();
 }
 async wizardSubmit(text){
  const w=this.wizard;
  const command=text.trim();
  if(command==='/cancel'){this.cancelWizard();return;}
  if(command==='/back'||(w.step>=2&&command==='back')){
   this.notice='';
   if(w.step===0)this.cancelWizard();else this.setWizardStep(w.step-1);
   return;
  }
  const view=/^\/view(?:\s+(\S+))?$/.exec(command);
  if(view||(w.step===3&&command==='view')){
   this.setWizardStep(w.step);
   if(view?.[1])this.setView(view[1]);else await this.chooseTask();
   return;
  }
  if(w.step===3&&/^\/?create$/i.test(command)){
   this.setWizardStep(3);
   throw Error('请输入目标 URL，或输入 - 跳过。/back 返回修改附件。');
  }
  let value=command;
  try{
   if(w.step===2&&/^\/browse(?:\s|$)/.test(value)){
    value=await this.browseAttachment(value.slice(7).trim());
    if(value===null){this.setWizardStep(2);return;}
   }
   if(w.step<2&&!value)throw Error('此项不能为空');
   if(w.step===1&&value.length>90000)throw Error('题意不能超过 90000 个字符');
   if(w.step>=2&&value==='-')value='';
   if(w.step===2&&value)resolveAttachmentPath(value);
   w.values[wizardFields[w.step]]=value;
   if(w.step<3){this.notice='';this.setWizardStep(w.step+1);return;}
   this.notice='正在创建独立题目与附件快照…';this.render();
   const record=await this.contest.add(w.values);
   this.wizard=null;this.selected=record.task.id;this.bound=this.selected;this.tab='output';this.detail=null;
   this.notice='题目已创建，进入首次启动队列。/start 启动调度';
   this.editor.setText('');this.persist();this.render();
  }catch(error){
   if(w.step===3&&error instanceof AttachmentInputError)this.setWizardStep(2);
   else{
    w.draft=command;this.editor.setText(w.draft);this.persist();
   }
   throw error;
  }
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
  const usage=s?sessionUsage(s.store,s.config,s.sessionWindow):null;
  this.binding.setText(safeText(this.wizard?`创建 ${this.wizard.step+1}/4：${['题目标题','粘贴题意（支持多行）','附件：文件或目录路径 · /browse 选择 · - 跳过','内网目标 URL 或 - 跳过'][this.wizard.step]} · /back 上一步 · /cancel 取消`:`输入绑定 → ${c.taskLabel(this.bound||this.selected)||'无题目'} · 面板 ${this.tab}${usage?' · '+usageLine(usage)+'\n'+contextLine(usage):''}`));
  this.footer.setText(safeText((this.notice||c.notice||'Ctrl+C 中断生成 · Ctrl+R 恢复 · /compact 压缩 · /effort 调整思考 · /quit 退出')+'\n'+(c.notice&&this.notice?c.notice:'暂停推理保留命令运行；/cancel 命令ID 单独取消。')));
  this.tui.requestRender();
 }
 start(){this.tui.start();this.render();}
 async close(){if(this.closed)return;this.closed=true;this.persistDraft();this.notice='正在保存并停止推理…';this.render();try{await this.contest.close();}finally{this.contest.off('auxiliary',this.auxiliaryEvent);this.contest.off('change',this.changed);this.contest.off('agent',this.agentEvent);clearTimeout(this.renderTimer);this.tui.stop();this.onClose();}}
}
