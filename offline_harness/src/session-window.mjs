export function lastWindowEvent(store){
 return store.events.findLast(e=>['window_requested','window_applied','window_failed','model_changed'].includes(e.type));
}

export function windowSettings(config, window, soft) {
 const parse=value=>{
  const match=/^([1-9]\d*)(k?)$/i.exec(String(value));
  if(!match)throw Error('请输入正整数 token 数或 K，例如 65536 或 64K');
  const tokens=Number(match[1])*(match[2]?1024:1);
  if(!Number.isSafeInteger(tokens))throw Error('token 数过大');
  return tokens;
 };
 const contextTokens=parse(window),compactSoftTokens=parse(soft);
 if(contextTokens>config.contextTokens)throw Error('会话窗口超过后端容量 '+config.contextTokens);
 const margin=config.safetyTokens??2048;
 const available=contextTokens-margin,cap=available-config.generationTokens;
 if(cap<512||available<=(config.compactTokens??4096)+256)
  throw Error('窗口太小，无法预留生成和压缩空间');
 if(compactSoftTokens<256||compactSoftTokens>cap)
  throw Error('软压缩线须在 256 到 '+cap+' 之间，以预留输出空间');
 return {contextTokens,compactSoftTokens};
}
