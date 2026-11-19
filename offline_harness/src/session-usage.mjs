import {lastWindowEvent} from './session-window.mjs';

export function sessionUsage(store,config,sessionWindow){
 const requests=store.events.filter(e=>e.type==='model_request'),usages=new Map(store.events.filter(e=>e.type==='model_usage').map(e=>[e.data.requestId,e.data.completion_tokens]));
 const known=requests.filter(e=>Number.isInteger(usages.get(e.data.requestId)));
 const last=requests.at(-1),compact=store.events.findLast(e=>e.type==='compact_commit'),changed=store.events.findLast(e=>e.type==='model_changed');
 let context=null;
 if(compact&&compact.seq>(last?.seq??-1))context=compact.data.restored_tokens;
 else if(last&&last.seq>(changed?.seq??-1)&&Number.isInteger(last.data.prompt_tokens))context=last.data.prompt_tokens+(usages.get(last.data.requestId)??0);
 return {turns:requests.length,ordinary:requests.filter(e=>!e.data.kind).length,compacts:requests.filter(e=>e.data.kind==='compact').length,
  generated:known.reduce((sum,e)=>sum+usages.get(e.data.requestId),0),unreported:requests.length-known.length,
  context,soft:sessionWindow?.compactSoftTokens??config.compactSoftTokens??Math.min(config.promptTokens??40960,40960,config.contextTokens-(config.generationTokens??8192)-(config.safetyTokens??2048)),total:sessionWindow?.contextTokens??config.contextTokens};
}
export const tokenLabel=n=>n>=1024?(n/1024).toFixed(1).replace(/\.0$/,'')+'K':String(n);
export function contextLine(stats,width=20){
 const total=stats.total,used=Math.max(0,Math.min(total,stats.context??0)),soft=Math.max(0,Math.min(total,stats.soft));
 const position=Math.round(used/total*width),mark=Math.min(width-1,Math.round(soft/total*width));
 const bar=Array.from({length:width},(_,i)=>i===mark?'│':i<position?'━':'─').join('');
 return `上下文 ${stats.context===null?'待计数':tokenLabel(stats.context)}/${tokenLabel(total)} [${bar}│] · 软线 ${tokenLabel(stats.soft)}`;
}
export function usageLine(stats){return `已用 ${stats.turns} 轮 · 累计生成 ${stats.generated.toLocaleString('en-US')} tokens${stats.unreported?' · '+stats.unreported+' 次用量未确认':''}`;}
export function budgetText(session){
 const s=sessionUsage(session.store,session.config,session.sessionWindow),g=session.generationControls();
 const latest=lastWindowEvent(session.store);
 return [usageLine(s),`普通调用 ${s.ordinary} 次 · Compact ${s.compacts} 次`,contextLine(s),
  `软压缩线 ${s.soft.toLocaleString('en-US')} tokens · 上下文总长 ${s.total.toLocaleString('en-US')} tokens`,
  `后端容量 ${session.config.contextTokens.toLocaleString('en-US')} tokens`,
  ...(latest?.type==='window_requested'?[`待应用：窗口 ${latest.data.settings.contextTokens} · 软线 ${latest.data.settings.compactSoftTokens}`]:[]),
  ...(latest?.type==='window_failed'?['窗口设置未生效：'+latest.data.error]:[]),
  `思考 ${g.current.thinking?'开启':'关闭'} · 强度 ${g.current.reasoningEffort} · 思考上限 ${g.current.reasoningTokens===-1?'随输出预算':g.current.reasoningTokens}`,
  `单次输出上限 ${session.config.generationTokens.toLocaleString('en-US')} tokens`].join('\n');
}
