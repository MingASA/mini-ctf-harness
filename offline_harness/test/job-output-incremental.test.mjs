import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {JOB_SCRIPTS} from '../src/broker.mjs';
test('actual Python output reader seeks by byte offset, preserves UTF-8 across chunks and handles truncation',t=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'output-offset-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const id='f'.repeat(32),root=path.join(work,'.offline-jobs',id);fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'status.json'),JSON.stringify({status:'finished',exit_code:0}));
 const expected='x'.repeat(65535)+'中文尾部';fs.writeFileSync(path.join(root,'stdout'),expected);fs.writeFileSync(path.join(root,'stderr'),'');
 const read=(a,b=0)=>JSON.parse(execFileSync('python3',['-c',JOB_SCRIPTS.read,id,work,String(a),String(b)],{encoding:'utf8'}));
 const first=read(0);assert.equal(first.stdout,'x'.repeat(65535));assert.equal(first.stdout_next_offset,65535);
 const next=read(first.stdout_next_offset);assert.equal(first.stdout+next.stdout,expected);assert.equal(next.stdout_truncated,false);
 const unchanged=read(next.stdout_next_offset);assert.equal(unchanged.stdout,'');
 fs.writeFileSync(path.join(root,'stdout'),'reset');const reset=read(next.stdout_next_offset);assert.equal(reset.stdout_reset,true);assert.equal(reset.stdout,'reset');
});
