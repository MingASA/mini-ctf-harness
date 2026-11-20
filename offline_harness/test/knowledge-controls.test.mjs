import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {loadCatalog} from '../src/knowledge/catalog.mjs';
import {askReference} from '../src/knowledge/reader.mjs';
import {assertExperimentIdle} from '../src/native.mjs';

const lookup=loadCatalog();
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-controls-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));return 'http://127.0.0.1:'+s.address().port+'/v1';}
function config(root,baseUrl='http://127.0.0.1:8080'){
 const configFile=path.join(root,'config.json'),lease=path.join(root,'lease.json');
 fs.writeFileSync(configFile,JSON.stringify({model:{baseUrl},modelLease:lease}));return {configFile,lease};
}

test('offline CLI works in a checkout with no installed inference SDK',t=>{
 const root=temp(t);
 fs.cpSync(new URL('../src/',import.meta.url),path.join(root,'offline_harness/src'),{recursive:true});
 fs.cpSync(new URL('../../knowledge/',import.meta.url),path.join(root,'knowledge'),{recursive:true});
 const result=spawnSync(process.execPath,[path.join(root,'offline_harness/src/knowledge/cli.mjs'),'search','CRC32'],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(result.stdout).results[0].id,'formats/png/crc-coverage');
});

test('unknown technical subjects do not match generic prose or fragments of compound identifiers',()=>{
 for(const query of ['PHP fibers 怎么使用','QUIC 协议如何工作','safe-linking tcache glibc 2.35','PNG acTL 数据块长度','sqlite FTS5 参数怎么配置','JavaScript prototype pollution',
  '堆块释放链表指针加密算法','浏览器原型链污染漏洞利用','如何配置代理服务器','二次注入怎么绕过过滤'])
  assert.equal(lookup({op:'search',query}).total,0,query);
 assert.equal(lookup({op:'search',query:'PHP8 assert 字符串'}).results[0].id,'languages/php/assert-string');
});

test('development and validation question sets retain supported references and abstain on uncovered topics',()=>{
 for(const file of ['knowledge-heldout.json','knowledge-validation.json']){
  const data=JSON.parse(fs.readFileSync(new URL('./fixtures/'+file,import.meta.url)));
  for(const [query,id] of data.positive)assert.ok(lookup({op:'search',query}).results.some(r=>r.id===id),query);
  for(const query of data.negative)assert.equal(lookup({op:'search',query}).total,0,query);
 }
});

test('search pages are complete, stable, filter-preserving and have no hard page-size ceiling',()=>{
 const request={op:'search',query:'PNG',tag:'misc',scope:'formats/png'};
 const all=lookup({...request,limit:100});assert.ok(all.results.length>5);assert.equal(all.total,all.results.length);
 const ids=[];let offset=0;
 do{const page=lookup({...request,offset,limit:2});assert.equal(page.total,all.total);ids.push(...page.results.map(r=>r.id));offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(ids,all.results.map(r=>r.id));assert.equal(new Set(ids).size,ids.length);
 assert.deepEqual(lookup({...request,offset:all.total}),{results:[],total:all.total,nextOffset:null});
 for(const field of ['offset','limit'])for(const value of [NaN,Infinity,1.5,'2',-1])assert.throws(()=>lookup({...request,[field]:value}));
 assert.equal(lookup({op:'search',query:'CRC32 '.repeat(1000)}).results[0].id,'formats/png/crc-coverage');
});

test('large valid cards, aliases and source URLs are read without the former size limits',t=>{
 const root=temp(t);fs.mkdirSync(path.join(root,'topic'));
 const card=JSON.parse(fs.readFileSync(new URL('../../knowledge/formats/png/crc-coverage.json',import.meta.url)));
 for(const field of ['title','summary','detail','boundary','applies','relevance'])card[field]+=' 中文 reference '.repeat(1000);
 card.aliases=Array.from({length:30},(_,i)=>'alias'+i+'a'.repeat(100));
 card.sources.reference+='?section='+'a'.repeat(1000);
 fs.writeFileSync(path.join(root,'topic','large.json'),JSON.stringify(card));
 const loaded=loadCatalog(root)({op:'get',id:'topic/large'});
 assert.equal(loaded.detail,card.detail);assert.equal(loaded.boundary,card.boundary);assert.equal(loaded.sources.reference,card.sources.reference);
});

test('standalone reader refuses active experiments, held leases, and resident competition endpoints before fetching',async t=>{
 const root=temp(t);let calls=0;
 const baseUrl=await server(t,(req,res)=>{calls++;res.end('{}');});
 const {configFile,lease}=config(root,baseUrl),options={baseUrl,model:'fixture',question:'PNG CRC32',lookup,configFile};
 const receipt=path.join(root,'experiment.json');fs.writeFileSync(receipt,JSON.stringify({pid:process.pid}));
 await assert.rejects(askReference({...options,guard:()=>assertExperimentIdle(receipt)}),/experiment is running/);
 await assert.rejects(askReference(options),/separate model endpoint/);
 assert.equal(fs.existsSync(lease),false);
 config(root);fs.writeFileSync(lease,JSON.stringify({pid:process.pid,contestDir:root}));
 await assert.rejects(askReference(options),/lease held/);assert.equal(JSON.parse(fs.readFileSync(lease)).pid,process.pid);
 assert.equal(calls,0);
});

test('reader supports more than eight turns and three tools, and releases the lease on completion',async t=>{
 const root=temp(t),{configFile,lease}=config(root);let n=0;
 const baseUrl=await server(t,async(req,res)=>{
  for await(const chunk of req){}n++;
  const message=n<=9?{role:'assistant',content:null,tool_calls:Array.from({length:4},(_,i)=>({id:`${n}-${i}`,type:'function',function:{name:'knowledge',arguments:'{"op":"browse"}'}}))}:{role:'assistant',content:'done'};
  res.end(JSON.stringify({choices:[{message}]}));
 });
 assert.equal(await askReference({baseUrl,model:'fixture',question:'Browse topics',lookup,configFile}),'done');
 assert.equal(n,10);assert.equal(fs.existsSync(lease),false);
});

test('operator cancellation aborts the reader request and releases its lease',async t=>{
 const root=temp(t),{configFile,lease}=config(root),controller=new AbortController();let started;
 const ready=new Promise(r=>started=r);
 const baseUrl=await server(t,(req,res)=>{started();});
 const running=askReference({baseUrl,model:'fixture',question:'PNG CRC32',lookup,configFile,signal:controller.signal});
 await ready;assert.equal(fs.existsSync(lease),true);controller.abort();await assert.rejects(running,/abort/i);
 assert.equal(fs.existsSync(lease),false);
});
