import {compactFixture} from './compact-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ContestQueue} from '../src/contest-queue.mjs';
import {TaskInbox} from '../src/inbox.mjs';
import {Store} from '../src/store.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'queue-inbox-'));

test('resume FIFO outranks fresh tasks and persists; priority stays within its queue',()=>{
 const root=temp();try{let q=new ContestQueue(root);q.enqueue('fresh-a','fresh',{priority:100});q.enqueue('waiting-a','resume');q.enqueue('waiting-b','resume');assert.equal(q.take().taskId,'waiting-a');q.settle('waiting-a','waiting_tool',[{id:'job'}]);q.enqueue('waiting-a','resume');q=new ContestQueue(root);assert.equal(q.take().taskId,'waiting-b');q.settle('waiting-b','awaiting_input');assert.equal(q.take().taskId,'waiting-a');q.settle('waiting-a','awaiting_input');assert.equal(q.take().taskId,'fresh-a');}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('inbox IDs, acknowledgements and restart are isolated by task store',()=>{
 const root=temp();try{const a=new TaskInbox('a',new Store(path.join(root,'a'))),b=new TaskInbox('b',new Store(path.join(root,'b')));a.enqueue('a note',{id:'same'});b.enqueue('b note',{id:'same'});a.mount([]);a.accepted({requestId:1,inboxIds:['same']});assert.equal(b.items()[0].status,'queued');const restored=new TaskInbox('a',new Store(path.join(root,'a')));assert.equal(restored.items()[0].status,'delivered');assert.throws(()=>a.enqueue('wrong',{id:'same'}),/reused/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('compression retains delivered human corrections and every undelivered observation; archive only removes mandatory pin',async()=>{
 const {ContextManager}=await import('../src/context.mjs');const root=temp();
 try{
  const store=new Store(root),inbox=new TaskInbox('fixture',store),messages=[{role:'system',content:'rules'},{role:'user',content:'original objective'}];
  inbox.enqueue('HUMAN_CORRECTION_CANARY',{id:'human'});inbox.enqueue('UNDELIVERED_RESULT_CANARY',{id:'result',kind:'observation'});inbox.mount(messages);inbox.accepted({requestId:1,inboxIds:['human']});
  for(let i=0;i<30;i++)messages.push({role:'assistant',content:[{type:'text',text:'retained transcript '.repeat(30)}],stopReason:'stop'},{role:'assistant',content:[{type:'text',text:'next experiment '+i}],stopReason:'stop'});
  for(const m of messages)if(!m.harnessInboxId)store.append('message',m);
  const manager=new ContextManager(store,{promptTokens:2600,contextTokens:12000,safetyTokens:64,compactTokens:1000,generationTokens:1000,compactTailGroups:0});const result=await manager.build(messages,async b=>Math.ceil(JSON.stringify(b).length/4),compactFixture);
  assert.ok(result.removed>40);assert.ok(JSON.stringify(result.messages).includes('HUMAN_CORRECTION_CANARY'));assert.ok(JSON.stringify(result.messages).includes('UNDELIVERED_RESULT_CANARY'));
  inbox.retire('human');const after=await manager.build(messages,async b=>Math.ceil(JSON.stringify(b).length/4),compactFixture);assert.equal(JSON.stringify(after.messages).includes('HUMAN_CORRECTION_CANARY'),false);assert.ok(JSON.stringify(after.messages).includes('UNDELIVERED_RESULT_CANARY'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
