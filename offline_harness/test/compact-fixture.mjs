import {COMPACT_FIELDS} from '../src/compact-prompts.mjs';
export const controlPayload=input=>{const text=input.messages.at(-1).content;return JSON.parse(text.slice(text.lastIndexOf('\n\n')+2));};
export function summary(extra=''){return Object.fromEntries(COMPACT_FIELDS.map(k=>[k,k==='current_work'?'Check the measured route':k==='next_step'?'Read the retained measurement and test the alternative input':k==='files_and_code_sections'?extra||'Original events retained':'None recorded']));}
export const envelope=(compact=summary())=>JSON.stringify(compact);
export async function compactFixture(){return envelope();}
export function auxiliary(){return envelope();}
export function auxiliarySse(inputTokens,completionTokens=300){return 'data: '+JSON.stringify({choices:[{delta:{content:auxiliary()},finish_reason:'stop'}],usage:{prompt_tokens:inputTokens,completion_tokens:completionTokens}})+'\n\ndata: [DONE]\n\n';}
