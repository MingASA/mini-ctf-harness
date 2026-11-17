import {hash} from './store.mjs';

export const EFFORTS=['off','low','medium','high','xhigh'];
export const generationSettings=cfg=>({thinking:cfg.thinking!==false,reasoningEffort:cfg.reasoningEffort??'medium',reasoningTokens:cfg.reasoningTokens});
export const bodySettings=body=>({thinking:body.chat_template_kwargs?.enable_thinking!==false,reasoningEffort:body.chat_template_kwargs?.reasoning_effort??'medium',reasoningTokens:body.reasoning_budget_tokens});
export const settingsHash=settings=>hash(JSON.stringify(settings??null));
export function effortSettings(level,budget,current,config){
 if(level==='none')level='off';
 if(!EFFORTS.includes(level))throw Error('Usage: /effort off|low|medium|high|xhigh [thinking_tokens|-1]');
 const result={...current,thinking:level!=='off',reasoningEffort:level==='off'?current.reasoningEffort:level};
 if(budget!==undefined){
  if(!/^(?:-1|[1-9][0-9]*)$/.test(String(budget)))throw Error('Thinking budget must be -1 or a positive integer');
  result.reasoningTokens=Number(budget);
  if(!Number.isSafeInteger(result.reasoningTokens)||(result.reasoningTokens!==-1&&result.reasoningTokens>=config.generationTokens))throw Error('Thinking budget must be below the total response limit');
 }
 return result;
}
