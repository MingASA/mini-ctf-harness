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

test('reports branch membership and payload from physical cell groups, including MTP',()=>{
 const pool=(id,unit,groups)=>({id,kind:'attention',capacity_cells:100,occupied_cells:50,free_cells:50,shared_cells:20,exclusive_cells:30,
  membership_groups:groups,layers:[{id:0,tensors:[{storage_id:id+'-k',bytes_per_cell:unit}]}]});
 const target=pool('target',1024*1024,[{sequences:[0,1],cells:20},{sequences:[0],cells:15},{sequences:[1],cells:10},{sequences:[1,4],cells:5}]);
 const draft=pool('draft',512*1024,[{sequences:[0,1],cells:12},{sequences:[1],cells:5}]);
 const text=backendUsageText({schema_version:1,scheduler:{generating:2,prefill:0,retained_slots:2},slots:[{id:0},{id:1}],
  contexts:{target:{supported:true,pools:[target]},draft:{supported:true,pools:[draft]}}},{mainSlot:0,branchSlot:1});
 assert.match(text,/主模型 分支 slot 1 · 使用 35 cells · 与主线共享 20 · 分支独占 10/);
 assert.match(text,/主模型 分支 KV 有效载荷 35\.0 MiB · 独占 10\.0 MiB/);
 assert.match(text,/MTP 分支 slot 1 · 使用 17 cells · 与主线共享 12 · 分支独占 5/);
 assert.match(text,/MTP 分支 KV 有效载荷 8\.5 MiB · 独占 2\.5 MiB/);
 assert.match(text,/分支注意力 KV 合计 43\.5 MiB · 独占 12\.5 MiB/);
});

test('does not claim exact ownership when the backend omits membership',()=>{
 const pool={id:'p',kind:'attention',capacity_cells:10,occupied_cells:1,free_cells:9,shared_cells:0,exclusive_cells:1};
 const text=backendUsageText({schema_version:1,scheduler:{generating:0,prefill:0,retained_slots:1},slots:[{id:0}],contexts:{target:{supported:true,pools:[pool]}}},{branchSlot:1});
 assert.match(text,/分支 KV 归属：后端未提供完整统计/);
});
