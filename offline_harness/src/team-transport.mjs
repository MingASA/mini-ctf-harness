import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {pipeline} from 'node:stream/promises';
import {Store,atomic,hash} from './store.mjs';
import {validateServiceUrl} from './service-endpoint.mjs';

export function lanOrigin(value){
 const url=validateServiceUrl(value);
 if(url.protocol!=='http:'||url.pathname!=='/')throw Error('Team address must be an HTTP LAN origin, e.g. http://192.168.1.10:18765');
 return url.origin;
}
const jsonBody=async request=>{const chunks=[];for await(const b of request)chunks.push(b);return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
const reply=(response,status,data)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(data));};
const localAddress=()=>Object.values(os.networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal)?.address??'127.0.0.1';

// A durable outbox and idempotent inbox. No inference or scheduling lives here.
export class TeamTransport extends EventEmitter {
 constructor(root,config,{receive,read,info=()=>({})}){
  super();this.config=config;this.receive=receive;this.read=read;this.info=info;
  if(typeof config.secret!=='string'||!config.secret.trim())throw Error('Team networking needs the same team.secret on participating machines');
  this.store=new Store(root);const file=path.join(root,'node.json');
  if(!fs.existsSync(file))atomic(file,{id:crypto.randomUUID()});
  this.id=JSON.parse(fs.readFileSync(file)).id;this.name=config.name??os.hostname();
  this.errors=new Map();this.lastContact=new Map();this.incoming=Promise.resolve();this.controller=new AbortController();
 }
 self(){return {id:this.id,name:this.name,url:this.url};}
 relocate(peer){this.store.append('peer_address',{id:peer.id,url:lanOrigin(peer.url)});}
 pending(){const done=new Set(this.store.events.filter(e=>e.type==='sent').map(e=>e.data.id));return this.store.events.filter(e=>e.type==='outgoing'&&!done.has(e.data.message.id)).map(e=>{const address=this.store.events.findLast(a=>a.type==='peer_address'&&a.data.id===e.data.to.id)?.data.url;return {...e.data,to:{...e.data.to,url:address??e.data.to.url}};});}
 async start(){
  if(this.server)return this.self();
  this.server=http.createServer((req,res)=>{this.serve(req,res).catch(error=>{if(!res.headersSent)reply(res,400,{error:error.message});else res.destroy();});});
  try{await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.config.port??18765,this.config.host??'0.0.0.0',()=>{this.server.off('error',reject);resolve();});});}catch(error){this.server=null;throw error;}
  this.server.on('error',error=>{this.error=error.message;this.emit('change');});
  try{this.url=lanOrigin(this.config.advertiseUrl??`http://${this.config.host&&this.config.host!=='0.0.0.0'?this.config.host:localAddress()}:${this.server.address().port}`);}catch(error){await new Promise(r=>this.server.close(r));this.server=null;throw error;}
  // Replay a receive that was persisted before the previous process stopped.
  for(const e of this.store.events.filter(e=>e.type==='incoming')){const work=()=>this.accept(e.data.message);this.incoming=this.incoming.then(work,work).catch(error=>{this.error=error.message;});}
  await this.incoming;
  this.timer=setInterval(()=>this.flush(),this.config.retryMs??2000);this.timer.unref();
  await this.startDiscovery();this.flush();return this.self();
 }
 authorized(value){
  const actual=Buffer.from(value??''),expected=Buffer.from('Bearer '+this.config.secret);
  return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
 }
 async serve(req,res){
  if(!this.authorized(req.headers.authorization)){reply(res,401,{error:'Team authentication failed'});return;}
  const url=new URL(req.url,'http://local');
  if(req.method==='GET'&&url.pathname==='/info'){reply(res,200,{...this.self(),...this.info()});return;}
  if(req.method==='POST'&&url.pathname==='/message'){
   const message=await jsonBody(req);
   const work=()=>this.accept(message),pending=this.incoming.then(work,work);this.incoming=pending.catch(()=>{});
   reply(res,200,{id:message.id,nodeId:this.id,result:await pending});return;
  }
  if(req.method==='POST'&&url.pathname==='/read'){
   const result=await this.read(await jsonBody(req));
   if(result?.stream){res.writeHead(200,{'content-type':'application/octet-stream'});await pipeline(result.stream,res);}
   else reply(res,200,result);
   return;
  }
  reply(res,404,{error:'Unknown team endpoint'});
 }
 async accept(message){
  if(!message||typeof message.id!=='string'||!message.id||typeof message.from?.id!=='string'||!message.from.id||typeof message.teamId!=='string'||!message.teamId)throw Error('Invalid team message identity');
  if(message.recipientId!==this.id)throw Error('Message is addressed to a different node');
  lanOrigin(message.from.url);
  const digest=hash(JSON.stringify(message));
  const prior=this.store.events.find(e=>e.type==='incoming'&&e.data.message.id===message.id);
  if(prior&&prior.data.digest!==digest)throw Error('Team message ID reused with different content');
  const applied=this.store.events.find(e=>e.type==='received'&&e.data.id===message.id);if(applied)return applied.data.result;
  if(!prior)this.store.append('incoming',{message,digest});
  const result=await this.receive(message);
  this.store.append('received',{id:message.id,result});this.lastContact.set(message.from.id,Date.now());this.emit('change');return result;
 }
 queue(to,message){
  const old=this.store.events.find(e=>e.type==='outgoing'&&e.data.message.id===message.id);
  const payload={...message,recipientId:to.id,from:old?.data.message.from??this.self()};
  if(old){if(hash(JSON.stringify(old.data.message))!==hash(JSON.stringify(payload))||old.data.to.id!==to.id)throw Error('Outgoing team message ID reused');}
  else this.store.append('outgoing',{to:{...to,url:lanOrigin(to.url)},message:payload});
  this.flush();this.emit('change');return {message_id:message.id,queued:!this.store.events.some(e=>e.type==='sent'&&e.data.id===message.id)};
 }
 async request(origin,route,body,{raw=false,signal}={}){
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(Error('Team request timed out')),this.config.timeoutMs??15000);
  try{
   const response=await fetch(lanOrigin(origin)+route,{method:body===undefined?'GET':'POST',redirect:'error',
    headers:{authorization:'Bearer '+this.config.secret,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.any([this.controller.signal,timeout.signal,...(signal?[signal]:[])])});
   if(!response.ok){const detail=await response.json().catch(()=>({}));throw Error(detail.error??`Team HTTP ${response.status}`);}
   // No total size/time ceiling on evidence streams. Shutdown still cancels them.
   return raw?response:await response.json();
  }finally{clearTimeout(timer);}
 }
 flush(){
  if(!this.server||this.controller.signal.aborted||this.flushing)return this.flushing;
  const groups=new Map();for(const item of this.pending()){const key=item.to.id+'\0'+item.message.teamId,list=groups.get(key)??[];list.push(item);groups.set(key,list);}
  const run=Promise.all([...groups.values()].map(async items=>{
   for(const {to,message} of items){
    const errorKey=to.id+'/'+message.teamId;
    try{
     const result=await this.request(to.url,'/message',message);
     if(result.id!==message.id||result.nodeId!==to.id)throw Error('Team delivery receipt identity mismatch');
     const receipt=this.store.append('sent',{id:message.id,to:to.id,result:result.result});this.emit('sent',receipt.data);this.errors.delete(errorKey);this.lastContact.set(to.id,Date.now());this.emit('change');
    }catch(error){if(!this.controller.signal.aborted){this.errors.set(errorKey,error.message);this.emit('change');}break;}
   }
  })).finally(()=>{if(this.flushing===run)this.flushing=null;});
  this.flushing=run;run.catch(error=>{this.error=error.message;this.emit('change');});return run;
 }
 async startDiscovery(){
  if(this.config.discovery===false)return;
  const socket=dgram.createSocket({type:'udp4',reuseAddr:true});this.discovery=socket;
  socket.on('error',error=>{this.discoveryError=error.message;this.emit('change');});
  socket.on('message',(bytes,peer)=>{
   try{const msg=JSON.parse(bytes);if(msg.protocol==='mini-ctf-team'&&msg.discover&&msg.nonce){
    socket.send(Buffer.from(JSON.stringify({protocol:msg.protocol,nonce:msg.nonce,id:this.id,name:this.name,port:this.server.address().port,...this.info()})),peer.port,peer.address);
   }}catch{}
  });
  await new Promise(resolve=>{socket.once('error',resolve);socket.bind(this.config.discoveryPort??18766,'0.0.0.0',()=>{socket.off('error',resolve);resolve();});});
 }
 async discover(){
  const socket=dgram.createSocket('udp4'),nonce=crypto.randomUUID(),found=new Map();
  try{
   await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,'0.0.0.0',()=>{socket.off('error',reject);resolve();});});socket.setBroadcast(true);
   socket.on('message',(bytes,peer)=>{try{const msg=JSON.parse(bytes);if(msg.protocol==='mini-ctf-team'&&msg.nonce===nonce&&msg.id!==this.id)found.set(msg.id,{...msg,url:lanOrigin(`http://${peer.address}:${msg.port}`)});}catch{}});
   socket.on('error',()=>{});
   const bytes=Buffer.from(JSON.stringify({protocol:'mini-ctf-team',discover:true,nonce}));
   socket.send(bytes,this.config.discoveryPort??18766,this.config.broadcastAddress??'255.255.255.255');
   await new Promise(r=>setTimeout(r,this.config.discoveryMs??1000));return [...found.values()];
  }finally{socket.close();}
 }
 async close(){
  this.controller.abort();clearInterval(this.timer);
  if(this.discovery)try{this.discovery.close();}catch{}
  if(this.server)await new Promise(resolve=>{this.server.close(resolve);this.server.closeAllConnections();});
  await this.flushing?.catch(()=>{});await this.incoming.catch(()=>{});
 }
}
