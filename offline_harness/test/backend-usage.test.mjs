import test from 'node:test';
import assert from 'node:assert/strict';
import {backendUsageText} from '../src/backend-usage.mjs';

test('counts each physical pool once when MTP shares its target backing',()=>{
 const pool={id:'pool-0',kind:'attention',capacity_cells:100,occupied_cells:20,free_cells:80,shared_cells:12,exclusive_cells:8};
 const state={id:'pool-1',kind:'recurrent',capacity_cells:4,occupied_cells:2};
 const text=backendUsageText({
  schema_version:1,
  scheduler:{generating:1,prefill:0,retained_slots:2},
  slots:[{id:0},{id:1}],
  contexts:{target:{supported:true,pools:[pool,state]},draft:{supported:true,pools:[pool]}},
 });
 assert.match(text,/生成 1 路 · 预填充 0 路 · KV 驻留 2 个 slot/);
 assert.match(text,/已用 20\/100 · 空闲 80 · 共享 12 · 独占 8/);
 assert.match(text,/主模型 循环状态 · 已用 2\/4/);
 assert.equal(text.match(/KV cells/g).length,1);
});
