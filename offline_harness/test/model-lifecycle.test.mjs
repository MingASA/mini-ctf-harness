import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Contest} from '../src/contest.mjs';
import {CompetitionTerminal} from '../src/terminal.mjs';
import {atomic} from '../src/store.mjs';

class Terminal {
 columns=110;rows=30;kittyProtocolActive=false;
 start(){}stop(){}write(){}drainInput(){return Promise.resolve();}
 moveBy(){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(){}setProgress(){}setProgramStatus(){}
}
async function until(check){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){if(check())return;await delay(25);}
 assert.fail('Timed out waiting for fixture model ownership');
}
function alive(pid){
 try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1)[0]!=='Z';}catch(error){if(error.code==='ENOENT')return false;throw error;}
}

test('/model replaces real managed processes, recovers cancelled loading, and reloads after close',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-lifecycle-'));
 let contest,ui;
 try{
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const baseUrl=`http://127.0.0.1:${port}`,runtime=path.join(root,'runtime');
  const exe=path.join(root,'fixture-model'),modelPath=path.join(root,'fixture.gguf');
  fs.writeFileSync(modelPath,'fixture weights');
  fs.writeFileSync(exe,`#!/usr/bin/python3
import json,sys
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler,HTTPServer
a=SimpleNamespace(alias=sys.argv[sys.argv.index('--alias')+1],port=int(sys.argv[sys.argv.index('--port')+1]),c=int(sys.argv[sys.argv.index('-c')+1]))
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  data={'/health':{'status':'loading' if a.alias=='loading' else 'ok'},'/v1/models':{'data':[{'id':a.alias}]},'/props':{'default_generation_settings':{'n_ctx':a.c}},'/slots':[{'id':0,'is_processing':False,'n_ctx':a.c}]}[self.path]
  self.send_response(200);self.end_headers();self.wfile.write(json.dumps(data).encode())
HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
`,{mode:0o700});
  contest=new Contest({contestDir:path.join(root,'contest'),modelLease:path.join(root,'lease.json'),
   model:{model:'unloaded',baseUrl,contextTokens:8192,promptTokens:4096,generationTokens:1024},
   models:['alpha','beta','loading'].map(id=>({id,model:id,modelPath,baseUrl,contextTokens:8192})),
   modelRuntime:{platform:'linux',exe,runDir:runtime,startupTimeoutMs:15000}}, {guard:()=>{}});
  ui=new CompetitionTerminal(contest,{terminal:new Terminal()});
  const owner=()=>JSON.parse(fs.readFileSync(path.join(runtime,'owner.json')));
  const select=async name=>{await ui.submit('/model '+name);await contest.modelSwitchPromise;};
  await select('alpha');const first=owner();
  assert.equal(contest.defaultModel.model,'alpha');assert.equal(contest.enabled,false);
  await select('beta');const second=owner();
  assert.equal(contest.defaultModel.model,'beta');assert.notEqual(first.pid,second.pid);assert.equal(alive(first.pid),false);
  await select('beta');assert.equal(owner().pid,second.pid);
  assert.equal(owner().requestId,second.requestId);assert.notEqual(owner().selectionId,second.selectionId);

  // A cancelled, delayed launcher must not replace a model reselected via /model.
  const stale={...JSON.parse(fs.readFileSync(path.join(runtime,'selection-'+first.requestId+'.json'))),requestId:'delayed'};
  const staleFile=path.join(runtime,'selection-delayed.json');atomic(staleFile,stale);atomic(path.join(runtime,'selection.json'),stale);
  await select('beta');const reselected=owner();
  await promisify(execFile)('python3',[new URL('../scripts/managed_server.py',import.meta.url).pathname,staleFile],{timeout:5000});
  assert.equal(owner().pid,reselected.pid);assert.equal(owner().selectionId,reselected.selectionId);

  await ui.submit('/model loading');
  const cancelled=assert.rejects(contest.modelSwitchPromise,/abort/i);
  await until(()=>fs.existsSync(path.join(runtime,'owner.json'))&&owner().model==='loading');
  const loading=owner();
  ui.interrupt();await cancelled;
  assert.equal(contest.defaultModel.model,'beta');
  await select('alpha');assert.equal(contest.defaultModel.model,'alpha');assert.equal(alive(loading.pid),false);
  const immutable=JSON.parse(fs.readFileSync(path.join(runtime,'selection-'+loading.requestId+'.json')));
  assert.equal(immutable.requestId,loading.requestId);assert.equal(immutable.model,'loading');
  assert.equal((await (await fetch(baseUrl+'/v1/models')).json()).data[0].id,'alpha');
  assert.equal(JSON.parse(fs.readFileSync(path.join(contest.root,'model-selection.json'))).settings.model,'alpha');

  await ui.submit('/close-server');assert.equal(contest.modelServerStopped,true);assert.ok(!ui.closed);
  assert.equal(fs.existsSync(path.join(runtime,'owner.json')),false);assert.equal(contest.lease,null);
  contest.start();assert.equal(contest.enabled,false);
  await select('beta');assert.equal(contest.modelServerStopped,false);assert.equal(owner().model,'beta');

  await ui.submit('/model loading');
  const cancelledAgain=assert.rejects(contest.modelSwitchPromise,/abort/i);
  await until(()=>owner().model==='loading');ui.interrupt();await cancelledAgain;
  await ui.submit('/close-server');assert.equal(fs.existsSync(path.join(runtime,'owner.json')),false);
  await select('alpha');assert.equal(contest.defaultModel.model,'alpha');
 }catch(error){
  const runtime=path.join(root,'runtime');
  if(fs.existsSync(runtime))for(const run of fs.readdirSync(runtime)){
   const log=path.join(runtime,run,'stderr.log');
   if(fs.existsSync(log))error.message+='\n'+fs.readFileSync(log,'utf8');
  }
  throw error;
 }finally{
  if(contest){await contest.modelSwitchPromise?.catch(()=>{});await contest.catalog.stopManagedServer();}
  await ui?.close();await contest?.close();fs.rmSync(root,{recursive:true,force:true});
 }
});

test('closing the model serializes switching and KV operations and reports stop failures',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-close-order-'));
 let finish,contest;
 try{
  contest=new Contest({contestDir:root,modelRuntime:{exe:'/fixture'}},{testMode:true,guard:()=>{},
   provision:async()=>({workDir:root,containerId:'fixture'}),
   sessionOptions:()=>({broker:{validate:async()=>{}},knowledge:{docs:[]}}),
   modelCatalog:{stopManagedServer:()=>new Promise((resolve,reject)=>{finish={resolve,reject};})}});
  await contest.add({id:'one',objective:'fixture'});
  const closing=contest.closeModelServer();await until(()=>finish);
  assert.equal(contest.closeModelServer(),closing);
  assert.throws(()=>contest.switchModel(undefined,'fixture'),/server to stop/);
  await assert.rejects(contest.offloadKV('one'),/model operation/);
  finish.reject(Error('stop failed'));await assert.rejects(closing,/stop failed/);
  assert.ok(!contest.modelServerStopped);assert.equal(contest.modelClosePromise,null);
  finish=null;const retry=contest.closeModelServer();await until(()=>finish);finish.resolve();await retry;
  assert.equal(contest.modelServerStopped,true);
 }finally{await contest?.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('closing a backend drains its branch, preserves branch history and permits reload',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-close-btw-'));
 let stopped=false,saved=false,drained=false,finish,contest;
 const running=new Promise(resolve=>{finish=resolve;});
 try{
  contest=new Contest({contestDir:root,modelRuntime:{exe:'/fixture'}},{testMode:true,guard:()=>{},
   modelCatalog:{stopManagedServer:async()=>{assert.ok(drained);stopped=true;}}});
  const branch={data:{kvMayExist:true,history:[{role:'user',content:'retain me'}]},running,
   pause:()=>{drained=true;finish();},save:()=>{saved=true;},removeAllListeners:()=>{}};
  contest.btw=branch;
  const closing=contest.closeModelServer();
  assert.throws(()=>contest.askBtw('new input'),/模型或 KV/);
  await closing;
  assert.ok(stopped&&saved);assert.equal(contest.btw,null);
  assert.equal(branch.data.kvMayExist,false);assert.equal(branch.data.history[0].content,'retain me');
 }finally{await contest?.close();fs.rmSync(root,{recursive:true,force:true});}
});
