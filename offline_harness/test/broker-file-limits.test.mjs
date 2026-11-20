import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {JOB_SCRIPTS} from '../src/broker.mjs';
const exec=promisify(execFile);
test('128MiB legitimate decompression succeeds and stdout/stderr retain all 12MiB each',{timeout:25000},async t=>{
 const base=process.env.CTF_LARGE_TEST_ROOT??os.tmpdir();fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'broker-large-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const id='9'.repeat(32),root=path.join(dir,'.offline-jobs',id);fs.mkdirSync(root,{recursive:true});
 const code="import gzip,os,sys; f=gzip.open('attachment.gz','wb'); [f.write(b'x'*1048576) for _ in range(128)]; f.close(); os.system('gunzip -kf attachment.gz'); assert os.stat('attachment').st_size==134217728; [os.write(1,b'o'*1048576) for _ in range(12)]; [os.write(2,b'e'*1048576) for _ in range(12)]";
 const command="python3 -c '"+code.replaceAll("'","'\\''")+"'";
 await exec('python3',['-c',JOB_SCRIPTS.worker,root,Buffer.from(command,'utf8').toString('base64'),'20',dir],{timeout:23000,maxBuffer:1024*1024});
 const state=JSON.parse(fs.readFileSync(path.join(root,'status.json'),'utf8'));assert.equal(state.status,'finished');assert.equal(state.exit_code,0);assert.equal(fs.statSync(path.join(dir,'attachment')).size,128*1024*1024);
 for(const name of ['stdout','stderr']){assert.equal(fs.statSync(path.join(root,name)).size,12*1024*1024);assert.equal(state[name+'_capture_limit_bytes'],null);assert.equal(state[name+'_capture_truncated'],false);assert.equal(state[name+'_discarded_bytes'],0);}
});
