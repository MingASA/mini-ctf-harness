const number=value=>value.toLocaleString('en-US');

export function backendUsageText(snapshot,{mainSlot=0,branchSlot}={}) {
 if(snapshot.schema_version!==1||!snapshot.contexts||!Array.isArray(snapshot.slots)) {
  throw Error('无效的 KV 统计快照');
 }
 const pools=new Map();
 const lines=[];
 let branchTotalBytes=0,branchExclusiveBytes=0,branchHasPayload=false,branchPrecise=true;
 const scheduler=snapshot.scheduler;
 if(!scheduler||![scheduler.generating,scheduler.prefill,scheduler.retained_slots].every(Number.isSafeInteger)) {
  throw Error('无效的后端运行状态');
 }
 lines.push(`生成 ${scheduler.generating} 路 · 预填充 ${scheduler.prefill} 路 · KV 驻留 ${scheduler.retained_slots} 个 slot`);
 for(const [name,context] of Object.entries(snapshot.contexts)) {
  if(!context?.supported){if(context)branchPrecise=false;continue;}
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
   if(Number.isInteger(branchSlot)) {
    let common=0,branch=0,exclusive=0,branchBytes=0,exclusiveBytes=0;
    const ownedTensors=new Set();
    let precise=true;
    for(const pool of attention) {
     if(!Array.isArray(pool.membership_groups)){precise=false;break;}
     let poolCommon=0,poolBranch=0,poolExclusive=0;
     for(const group of pool.membership_groups) {
      if(!Array.isArray(group.sequences)||!Number.isSafeInteger(group.cells)||group.cells<0)throw Error('无效的 KV 归属信息');
      if(!group.sequences.includes(branchSlot))continue;
      poolBranch+=group.cells;
      if(group.sequences.includes(mainSlot))poolCommon+=group.cells;
      if(group.sequences.length===1)poolExclusive+=group.cells;
     }
     common+=poolCommon;branch+=poolBranch;exclusive+=poolExclusive;
     for(const layer of pool.layers??[])for(const tensor of layer.tensors??[]) {
      if(ownedTensors.has(tensor.storage_id)||tensor.shared_storage)continue;
      ownedTensors.add(tensor.storage_id);
      if(!Number.isSafeInteger(tensor.bytes_per_cell)){precise=false;continue;}
      branchBytes+=poolBranch*tensor.bytes_per_cell;
      exclusiveBytes+=poolExclusive*tensor.bytes_per_cell;
     }
    }
    if(precise) {
     lines.push(`${label} 分支 slot ${branchSlot} · 使用 ${number(branch)} cells · 与主线共享 ${number(common)} · 分支独占 ${number(exclusive)}`);
     if(ownedTensors.size){lines.push(`${label} 分支 KV 有效载荷 ${(branchBytes/1024**2).toFixed(1)} MiB · 独占 ${(exclusiveBytes/1024**2).toFixed(1)} MiB`);branchTotalBytes+=branchBytes;branchExclusiveBytes+=exclusiveBytes;branchHasPayload=true;}
     else branchPrecise=false;
    }else{branchPrecise=false;lines.push(`${label} 分支 KV 归属：后端未提供完整统计`);}
   }
  }
  if(recurrent.length) {
   const used=recurrent.reduce((n,pool)=>n+pool.occupied_cells,0);
   const capacity=recurrent.reduce((n,pool)=>n+pool.capacity_cells,0);
   lines.push(`${label} 循环状态 · 已用 ${number(used)}/${number(capacity)}`);
   if(Number.isInteger(branchSlot)&&recurrent.every(pool=>Array.isArray(pool.membership_groups))){
    let owned=0,shared=0,exclusive=0;
    for(const pool of recurrent)for(const group of pool.membership_groups){
     if(!Array.isArray(group.sequences)||!Number.isSafeInteger(group.cells)||group.cells<0)throw Error('无效的循环状态归属信息');
     if(!group.sequences.includes(branchSlot))continue;
     owned+=group.cells;if(group.sequences.includes(mainSlot))shared+=group.cells;if(group.sequences.length===1)exclusive+=group.cells;
    }
    lines.push(`${label} 分支循环状态 · ${number(owned)} cells · 与主线共享 ${number(shared)} · 独占 ${number(exclusive)}`);
   }
  }
 }
 if(Number.isInteger(branchSlot)&&branchPrecise&&branchHasPayload)lines.push(`分支注意力 KV 合计 ${(branchTotalBytes/1024**2).toFixed(1)} MiB · 独占 ${(branchExclusiveBytes/1024**2).toFixed(1)} MiB`);
 return lines.join('\n');
}
