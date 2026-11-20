const number=value=>value.toLocaleString('en-US');

export function backendUsageText(snapshot) {
 if(snapshot.schema_version!==1||!snapshot.contexts||!Array.isArray(snapshot.slots)) {
  throw Error('无效的 KV 统计快照');
 }
 const pools=new Map();
 const lines=[];
 const scheduler=snapshot.scheduler;
 if(!scheduler||![scheduler.generating,scheduler.prefill,scheduler.retained_slots].every(Number.isSafeInteger)) {
  throw Error('无效的后端运行状态');
 }
 lines.push(`生成 ${scheduler.generating} 路 · 预填充 ${scheduler.prefill} 路 · KV 驻留 ${scheduler.retained_slots} 个 slot`);
 for(const [name,context] of Object.entries(snapshot.contexts)) {
  if(!context?.supported)continue;
  const unique=[];
  for(const pool of context.pools) {
   if(pools.has(pool.id))continue;
   pools.set(pool.id,pool);
   unique.push(pool);
  }
  const attention=unique.filter(pool=>['attention','attention_swa'].includes(pool.kind));
  const recurrent=unique.filter(pool=>pool.kind==='recurrent');
  const label=name==='target'?'主模型':'MTP';
  if(attention.length) {
   const sum=key=>attention.reduce((total,pool)=>{
    if(!Number.isSafeInteger(pool[key])||pool[key]<0)throw Error('无效的 KV cell 数量');
    return total+pool[key];
   },0);
   lines.push(`${label} KV cells · 已用 ${number(sum('occupied_cells'))}/${number(sum('capacity_cells'))} · 空闲 ${number(sum('free_cells'))} · 共享 ${number(sum('shared_cells'))} · 独占 ${number(sum('exclusive_cells'))}`);
   const tensors=new Set();
   let occupiedBytes=0,freeBytes=0;
   for(const pool of attention)for(const layer of pool.layers??[])for(const tensor of layer.tensors) {
    if(tensors.has(tensor.storage_id)||tensor.shared_storage)continue;
    tensors.add(tensor.storage_id);
    if(Number.isSafeInteger(tensor.bytes_per_cell)) {
     occupiedBytes+=pool.occupied_cells*tensor.bytes_per_cell;
     freeBytes+=pool.free_cells*tensor.bytes_per_cell;
    }
   }
   if(tensors.size)lines.push(`${label} KV 有效载荷 ${(occupiedBytes/1024**2).toFixed(1)} MiB · 空闲 cell 载荷容量 ${(freeBytes/1024**2).toFixed(1)} MiB`);
  }
  if(recurrent.length) {
   const used=recurrent.reduce((n,pool)=>n+pool.occupied_cells,0);
   const capacity=recurrent.reduce((n,pool)=>n+pool.capacity_cells,0);
   lines.push(`${label} 循环状态 · 已用 ${number(used)}/${number(capacity)}`);
  }
 }
 return lines.join('\n');
}
