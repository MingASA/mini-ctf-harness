import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {VisionClient} from '../src/vision-client.mjs';
test('configurable vision job contract submits, polls, retrieves and cancels on LAN adapter',async()=>{
 const calls=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,method:req.method,body:raw?JSON.parse(raw):null});res.end(JSON.stringify(req.method==='POST'?{jobId:'vision-fixture',status:'queued'}:req.url.endsWith('/result')?{jobId:'vision-fixture',status:'completed',text:'synthetic image description'}:{jobId:'vision-fixture',status:req.method==='DELETE'?'cancelled':'completed'}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const client=new VisionClient({endpoint:'http://127.0.0.1:'+server.address().port});const job=await client.submit({taskId:'fixture',requestId:'fixture-call',question:'Describe synthetic diagram',image:{mimeType:'image/png',data:'ZmFrZQ=='}});assert.equal((await client.status(job.jobId)).status,'completed');assert.equal((await client.result(job.jobId)).text,'synthetic image description');assert.equal((await client.cancel(job.jobId)).status,'cancelled');assert.deepEqual(calls.map(x=>x.method),['POST','GET','GET','DELETE']);assert.throws(()=>client.status('../escape'),/Invalid/);assert.throws(()=>new VisionClient({endpoint:'https://public.example'}),/LAN|private|literal|RFC1918/);}finally{await new Promise(r=>server.close(r));}
});
