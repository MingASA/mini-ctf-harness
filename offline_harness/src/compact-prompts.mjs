import fs from 'node:fs';
export const COMPACT_FIELDS=['primary_request_and_intent','key_technical_concepts','files_and_code_sections','errors_and_fixes','problem_solving','all_user_messages','pending_tasks','current_work','next_step'];
export const COMPACT_SCHEMA={type:'object',properties:Object.fromEntries(COMPACT_FIELDS.map(k=>[k,{type:'string',minLength:1}])),required:COMPACT_FIELDS,additionalProperties:false};
const promptFile=name=>fs.readFileSync(new URL('../prompts/user-v2/'+name,import.meta.url),'utf8');
export const COMPACT_INITIAL_PROMPT=promptFile('compact_initial.txt');
export const COMPACT_UPDATE_PROMPT=promptFile('compact_update.txt');
export const SOLVING_SYSTEM_PROMPT=promptFile('system_prompt.txt');
export const COMPACT_PROMPT=COMPACT_INITIAL_PROMPT;
export const compactPrompt=previous=>previous?COMPACT_UPDATE_PROMPT:COMPACT_INITIAL_PROMPT;
export function validateCompact(text){
 let value;try{value=JSON.parse(text);}catch{throw Error('Compact must be JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(Object.keys(value))!==JSON.stringify(COMPACT_FIELDS)||COMPACT_FIELDS.some(k=>typeof value[k]!=='string'||!value[k].trim()))throw Error('Compact requires nine ordered nonempty string fields');
 return value;
}
