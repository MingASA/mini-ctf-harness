#!/usr/bin/env node
// Operator-side process. Never mount its answer file or inbox into the task container.
import fs from 'node:fs';
import path from 'node:path';
import {hash,atomic} from './store.mjs';
export function grade(outbox,inbox,answersFile) {
  const answers=JSON.parse(fs.readFileSync(answersFile,'utf8'));
  fs.mkdirSync(inbox,{recursive:true,mode:0o700});
  let count=0;
  for(const name of fs.readdirSync(outbox).filter(x=>/^[a-f0-9]{64}\.json$/.test(x))) {
    const request=JSON.parse(fs.readFileSync(path.join(outbox,name),'utf8'));
    if(request.id!==name.slice(0,-5) || typeof request.candidate!=='string' || hash(request.candidate)!==request.candidate_sha256) throw Error('Invalid submission receipt');
    const answer=answers[request.task_id];
    if(!answer || typeof answer.value!=='string' || !['exact','ascii-casefold'].includes(answer.policy)) throw Error('Task has no explicit judge policy');
    const normalize=x=>answer.policy==='ascii-casefold'?x.replace(/[A-Z]/g,c=>c.toLowerCase()):x;
    const status=normalize(request.candidate)===normalize(answer.value)?'correct':'incorrect';
    atomic(path.join(inbox,name),{id:request.id,candidate_sha256:request.candidate_sha256,status});count++;
  }
  return {graded:count};
}
if(import.meta.url===new URL(process.argv[1]||'', 'file:').href) {
  try {if(process.argv.length!==5)throw Error('Usage: node src/judge.mjs OUTBOX INBOX PRIVATE_ANSWERS.json');console.log(JSON.stringify(grade(...process.argv.slice(2))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
