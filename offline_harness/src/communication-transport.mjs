import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Store,atomic,hash} from './store.mjs';
import {validateServiceUrl} from './service-endpoint.mjs';

export const PROTOCOL='mini-ctf-communicate-v1';
export const fault=(status,message)=>Object.assign(Error(message),{status});
export function peerOrigin(value){
 const url=validateServiceUrl(value);
 if(url.protocol!=='http:'||url.pathname!=='/')throw Error('Use an HTTP LAN origin, e.g. http://192.168.77.12:18765');
 return url.origin;
}
const body=async request=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const identity=value=>typeof value==='string'&&value.length>0;

// Only transports messages. Pairing and the ordinary Contest scheduler own session routing.
export class CommunicationTransport extends EventEmitter {
 constructor(root,config,{info,pair,validate,receive}){
  super();this.config=config;this.callbacks={info,pair,validate,receive};
  if(typeof config.secret!=='string'||!config.secret.trim())throw Error('Set the same communicate.secret on both machines');
  this.store=new Store(root);const file=path.join(root,'node.json');
  if(!fs.existsSync(file))atomic(file,{id:crypto.randomUUID()});
  this.id=JSON.parse(fs.readFileSync(file)).id;this.name=config.name??os.hostname();
  this.controller=new AbortController();this.incoming=Promise.resolve();this.errors=new Map();this.backoff=new Map();
 }
 self(){return {id:this.id,name:this.name,url:this.url};}
 serialize(operation){const pending=this.incoming.then(operation,operation);this.incoming=pending.catch(()=>{});return pending;}
 async start(){
  if(this.server)return this.self();
  if(!this.config.advertiseUrl&&(!this.config.host||['0.0.0.0','::'].includes(this.config.host)))throw Error('Set communicate.advertiseUrl to this machine’s reachable LAN IP; do not use the VPN or model address');
  if(this.config.advertiseUrl)peerOrigin(this.config.advertiseUrl);
  const server=http.createServer((req,res)=>this.serve(req,res).catch(error=>{if(!res.headersSent)reply(res,error.status??400,{error:error.message});else res.destroy();}));
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.config.port??18765,this.config.host??'0.0.0.0',()=>{server.off('error',reject);resolve();});});}
  catch(error){throw Error('Communication listener: '+error.message);}
  this.server=server;
  server.on('error',error=>{this.error=error.message;this.emit('change');});
  try{const host=this.config.host?.includes(':')?'['+this.config.host+']':this.config.host;this.url=peerOrigin(this.config.advertiseUrl??`http://${host}:${server.address().port}`);}
  catch(error){await new Promise(resolve=>server.close(resolve));this.server=null;throw error;}
  this.error=undefined;
  for(const event of this.store.events.filter(e=>e.type==='incoming'))this.serialize(()=>this.accept(event.data.message)).catch(error=>{this.error=error.message;});
  await this.incoming;
  this.timer=setInterval(()=>this.flush(),this.config.retryMs??2000);this.timer.unref();this.flush();return this.self();
 }
 authorized(value){const actual=Buffer.from(value??''),expected=Buffer.from('Bearer '+this.config.secret);return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);}
 async serve(req,res){
  if(this.controller.signal.aborted)throw fault(503,'Communication is closing');
  if(!this.authorized(req.headers.authorization))throw fault(401,'Communication authentication failed');
  if(req.method==='GET'&&req.url==='/info'){reply(res,200,{protocol:PROTOCOL,node:this.self(),sessions:this.callbacks.info()});return;}
  if(req.method==='POST'&&req.url==='/pair'){
   const request=await body(req),result=await this.serialize(()=>this.callbacks.pair(request));reply(res,200,result);return;
  }
  if(req.method==='POST'&&req.url==='/message'){
   const message=await body(req),result=await this.serialize(()=>this.accept(message));reply(res,200,{id:message.id,nodeId:this.id,sessionId:message.to.sessionId,...result});return;
  }
  throw fault(404,'Unknown communication endpoint');
 }
 async accept(message){
  if(!message||!identity(message.id)||!identity(message.from?.nodeId)||!identity(message.from?.sessionId)||!identity(message.to?.sessionId)||typeof message.text!=='string'||!message.text.trim())throw fault(400,'Invalid communication message');
  if(message.to.nodeId!==this.id)throw fault(409,'Message addressed to a different node; reconnect to the intended peer');
  peerOrigin(message.from.url);
  const digest=hash(JSON.stringify(message)),prior=this.store.events.find(e=>e.type==='incoming'&&e.data.message.id===message.id);
  if(prior&&prior.data.digest!==digest)throw fault(409,'Message ID reused with different content');
  const received=this.store.events.find(e=>e.type==='received'&&e.data.id===message.id);if(received)return received.data.result;
  this.callbacks.validate(message);
  if(!prior)this.store.append('incoming',{message,digest});
  const result=await this.callbacks.receive(message);
  this.store.append('received',{id:message.id,result});this.emit('change');return result;
 }
 address(nodeId,fallback){return this.store.events.findLast(e=>e.type==='peer_address'&&e.data.nodeId===nodeId)?.data.url??fallback;}
 relocate(nodeId,url){this.store.append('peer_address',{nodeId,url:peerOrigin(url)});this.backoff.clear();this.flush();}
 delivery(id){const done=this.store.events.findLast(e=>['sent','failed','cancelled'].includes(e.type)&&e.data.id===id);return done?{status:done.type==='sent'?'delivered':done.type,...done.data}: {id,status:'queued'};}
 pending(){return this.store.events.filter(e=>e.type==='outgoing'&&this.delivery(e.data.message.id).status==='queued').map(e=>e.data.message);}
 queue(message){
  const prior=this.store.events.find(e=>e.type==='outgoing'&&e.data.message.id===message.id);
  if(prior){if(hash(JSON.stringify(prior.data.message))!==hash(JSON.stringify(message)))throw Error('Outgoing communication ID reused');}
  else this.store.append('outgoing',{message});
  this.flush();this.emit('change');return this.delivery(message.id);
 }
 cancel(sessionId){for(const m of this.pending().filter(m=>m.from.sessionId===sessionId))this.store.append('cancelled',{id:m.id,reason:'Operator disconnected this session'});for(const key of this.errors.keys())if(key.startsWith(sessionId+'/')){this.errors.delete(key);this.backoff.delete(key);}this.emit('change');}
 async request(origin,route,value,signal){
  const response=await fetch(peerOrigin(origin)+route,{method:value===undefined?'GET':'POST',redirect:'error',headers:{authorization:'Bearer '+this.config.secret,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.config.timeoutMs??5000),...(signal?[signal]:[])])});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw fault(response.status,result.error??'Peer HTTP '+response.status);return result;
 }
 flush(){
  if(!this.server||this.controller.signal.aborted||this.flushing)return this.flushing;
  const groups=new Map();for(const m of this.pending()){const key=[m.from.sessionId,m.to.nodeId,m.to.sessionId].join('/'),list=groups.get(key)??[];list.push(m);groups.set(key,list);}
  const run=Promise.all([...groups].map(async([key,messages])=>{
   if((this.backoff.get(key)?.until??0)>Date.now())return;
   for(const message of messages){
    if(this.delivery(message.id).status!=='queued')continue;
    try{
     const receipt=await this.request(this.address(message.to.nodeId,message.to.url),'/message',message);
     if(receipt.id!==message.id||receipt.nodeId!==message.to.nodeId||receipt.sessionId!==message.to.sessionId)throw fault(409,'Peer receipt identity mismatch');
     this.store.append('sent',{id:message.id,receipt});this.errors.delete(key);this.backoff.delete(key);this.emit('change');
    }catch(error){
     if(this.controller.signal.aborted)break;
     this.errors.set(key,error.message);
     if([400,404,409,410,422].includes(error.status)){this.store.append('failed',{id:message.id,error:error.message});this.emit('failed',{id:message.id,error:error.message});this.emit('change');continue;}
     const attempts=(this.backoff.get(key)?.attempts??0)+1,delay=Math.min(30000,(this.config.retryMs??2000)*2**Math.min(attempts-1,5));
     this.backoff.set(key,{attempts,until:Date.now()+delay});this.emit('change');break;
    }
   }
  })).finally(()=>{if(this.flushing===run)this.flushing=null;});
  this.flushing=run;run.catch(error=>{this.error=error.message;this.emit('change');});return run;
 }
 async close(){
  this.controller.abort();clearInterval(this.timer);
  if(this.server)await new Promise(resolve=>{this.server.close(resolve);this.server.closeAllConnections();});
  await this.incoming;await this.flushing?.catch(()=>{});
 }
}
