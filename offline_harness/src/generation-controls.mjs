import {hash} from './store.mjs';

export const EFFORTS=['off','low','medium','high','xhigh'];
export const compactOutputLimit=cfg=>Math.min(cfg.compactTokens??4096,cfg.generationTokens);
export function generationSettings(cfg,scope='normal'){
 if(scope==='compact')return {thinking:cfg.compactThinking??false,reasoningEffort:cfg.compactReasoningEffort??cfg.reasoningEffort??'medium',
  reasoningTokens:cfg.compactReasoningTokens??Math.min(4096,compactOutputLimit(cfg)-1)};
 if(scope!=='normal')throw Error('Unknown thinking setting '+scope);
 return {thinking:cfg.thinking!==false,reasoningEffort:cfg.reasoningEffort??'medium',reasoningTokens:cfg.reasoningTokens};
}
export const compactFields=settings=>({compactThinking:settings.thinking,compactReasoningEffort:settings.reasoningEffort,compactReasoningTokens:settings.reasoningTokens});
export const bodySettings=body=>({thinking:body.chat_template_kwargs?.enable_thinking!==false,reasoningEffort:body.chat_template_kwargs?.reasoning_effort??'medium',reasoningTokens:body.reasoning_budget_tokens});
export const settingsHash=settings=>hash(JSON.stringify(settings??null));
export function effortSettings(level,budget,current,limit){
 if(level==='none')level='off';
 if(!EFFORTS.includes(level))throw Error('Usage: /effort off|low|medium|high|xhigh [thinking_tokens|-1]');
 const result={...current,thinking:level!=='off',reasoningEffort:level==='off'?current.reasoningEffort:level};
 if(budget!==undefined){
  if(!/^(?:-1|[1-9][0-9]*)$/.test(String(budget)))throw Error('Thinking budget must be -1 or a positive integer');
  result.reasoningTokens=Number(budget);
  if(!Number.isSafeInteger(result.reasoningTokens)||(result.reasoningTokens!==-1&&result.reasoningTokens>=limit))throw Error('Thinking budget must be below the total response limit');
 }
 return result;
}
