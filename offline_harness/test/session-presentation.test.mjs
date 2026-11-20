import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Contest} from '../src/contest.mjs';
import {TaskNumbers} from '../src/task-numbers.mjs';
import {sessionUsage,contextLine,usageLine,backendSlotText} from '../src/session-usage.mjs';
import {toolText} from '../src/tool-display.mjs';
import {Store} from '../src/store.mjs';
import {buildTools} from '../src/tools.mjs';
test('slot display distinguishes in-flight requests, idle prompt history and unavailable cell counts',()=>{
 const text=backendSlotText([{id:0,is_processing:true,n_prompt_tokens:600},{id:1,is_processing:false,n_prompt_tokens:500},{id:2,is_processing:false}]);
 assert.match(text,/处理请求（含预填充）1 · 记录有提示 tokens 的 slot 2/);
 assert.match(text,/slot 1 · 空闲 · 提示 tokens 500/);
 assert.match(text,/slot 2 · 空闲 · 提示 tokens 未报告/);
 assert.match(text,/KV cell.*未提供/);
 assert.throws(()=>backendSlotText([{id:0}]),/无效/);
});
const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-ui-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const options=root=>({testMode:true,guard:()=>{throw Error('No model requests in presentation tests');},provision:async id=>{const workDir=path.join(root,id);fs.mkdirSync(workDir,{recursive:true});return {containerId:id,workDir};},sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}})});
test('new tasks use 01, 02 and continue after restart',async t=>{
 const root=setup(t),cfg={contestDir:path.join(root,'contest')};let c=new Contest(cfg,options(root));
 try{assert.equal((await c.add({objective:'first'})).task.id,'01');assert.equal((await c.add({objective:'second'})).task.id,'02');await c.close();c=new Contest(cfg,options(root));assert.equal((await c.add({objective:'third'})).task.id,'03');assert.equal(c.taskLabel('03'),'03');}finally{await c.close();}
});
test('legacy task numbers preserve raw task IDs and journals across reopen',async t=>{
 const root=setup(t),cfg={contestDir:path.join(root,'contest')};let c=new Contest(cfg,options(root));
 try{await c.add({id:'task-long-alpha',objective:'first'});await c.add({id:'task-long-beta',objective:'second'});await c.close();fs.unlinkSync(path.join(c.root,'task-numbers.json'));
 const tasks=fs.readFileSync(path.join(c.root,'tasks.json')),journal=fs.readFileSync(c.session('task-long-beta').store.file);
 c=new Contest(cfg,options(root));assert.equal(c.taskLabel('task-long-alpha'),'01');assert.equal(c.session('02').task.id,'task-long-beta');c.priority('02',5);c.resume('01');assert.equal(c.queue.item('task-long-beta').priority,5);assert.equal(c.queue.state.readyResume[0].taskId,'task-long-alpha');
 assert.deepEqual(fs.readFileSync(path.join(c.root,'tasks.json')),tasks);assert.deepEqual(fs.readFileSync(c.session('02').store.file),journal);assert.equal((await c.add({objective:'third'})).task.id,'03');
 }finally{await c.close();}
});
test('number migration reserves existing numeric IDs and continues beyond 99',t=>{
 const root=setup(t),numbers=new TaskNumbers(root,['task-old-a','task-old-b','03']);assert.equal(numbers.label('task-old-a'),'01');assert.equal(numbers.label('task-old-b'),'02');assert.equal(numbers.allocate(),'04');
 let last;for(let i=5;i<=101;i++)last=numbers.allocate();assert.equal(last,'101');assert.equal(new TaskNumbers(root).allocate(),'102');
});
test('display adds reported tokens and shows current window, soft line and capacity',()=>{
 const cfg={contextTokens:55296,compactSoftTokens:40960},events=[{seq:0,type:'model_request',data:{requestId:1,prompt_tokens:5000,body:{max_tokens:8192}}},{seq:1,type:'model_usage',data:{requestId:1,completion_tokens:200}},{seq:2,type:'model_request',data:{requestId:2,prompt_tokens:6000,body:{max_tokens:8192}}}];
 const first=sessionUsage({events},cfg);assert.equal(first.generated,200);assert.equal(first.turns,2);assert.equal(first.unreported,1);assert.equal(first.context,6000);assert.match(usageLine(first),/已用 2 轮/);assert.match(usageLine(first),/200 tokens/);assert.match(contextLine(first),/54K/);assert.match(contextLine(first),/软线 40K/);assert.ok((contextLine(first).match(/│/g)||[]).length>=2);
 events.push({seq:3,type:'model_usage',data:{requestId:2,completion_tokens:300}});const second=sessionUsage({events},cfg);assert.equal(second.generated,500);assert.equal(second.context,6300);
 events.push({seq:4,type:'compact_commit',data:{restored_tokens:1200}});assert.equal(sessionUsage({events},cfg).context,1200);assert.equal(sessionUsage({events},cfg).generated,500);
});
test('UI unwraps only harness results and preserves literal task JSON',()=>{
 const input=JSON.stringify({status:'finished',job_id:'j2',exit_code:1,stdout:'first\nsecond\n',stderr:'target error\n'}),rendered=toolText('run_command',input);assert.match(rendered,/j2 · 已结束 · 退出码 1/);assert.ok(rendered.includes('first\nsecond'));assert.ok(rendered.includes('stderr:\ntarget error'));assert.ok(!rendered.includes('"stdout"'));assert.equal(toolText('read',input),input);assert.match(toolText('submit_flag','{"status":"awaiting_review","review_id":"c1"}'),/待人工确认/);
});
test('transport errors retain private diagnostics and expose a short useful tool error',async t=>{
 const store=new Store(setup(t)),error=Object.assign(Error('Command failed: PRIVATE_LAUNCHER_SCRIPT child supervisor'),{cmd:'docker exec python -c PRIVATE_LAUNCHER_SCRIPT',stderr:'Traceback:\nPermissionError: /work/.offline-jobs/'+ 'f'.repeat(32)+'/status.json'});
 const broker={read:async()=>{throw error;},readFile:async()=>{throw error;},start:async()=>({job_id:'j1',status:'finished',exit_code:1,stdout:'',stderr:'target program traceback with child field'})};const tools=buildTools(store,broker,{},{});
 const failed=await tools.find(t=>t.name==='wait_job').execute('wait',{job_id:'j1'});assert.ok(!failed.content[0].text.includes('PRIVATE_LAUNCHER_SCRIPT'));assert.ok(!failed.content[0].text.includes('supervisor'));assert.ok(!failed.content[0].text.includes('.offline-jobs'));assert.match(failed.content[0].text,/PermissionError/);assert.ok(store.events.some(e=>e.type==='tool_error'&&e.data.error.message.includes('PRIVATE_LAUNCHER_SCRIPT')));
 const read=await tools.find(t=>t.name==='read').execute('read',{path:'/work/file'});assert.equal(read.isError,true);assert.ok(!read.content[0].text.includes('PRIVATE_LAUNCHER_SCRIPT'));
 const target=await tools.find(t=>t.name==='run_command').execute('target',{command:'test'});assert.equal(JSON.parse(target.content[0].text).stderr,'target program traceback with child field');
});
