import {validateServiceUrl} from './service-endpoint.mjs';
export class VisionClient {
 constructor({endpoint,token,timeoutMs=15000,fetchImpl=fetch}){const u=validateServiceUrl(endpoint);this.base=u.href.replace(/\/$/,'');this.token=token;this.timeoutMs=timeoutMs;this.fetch=fetchImpl;}
 async request(route,method='GET',body){
  const r=await this.fetch(this.base+route,{method,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{'content-type':'application/json',...(this.token?{authorization:'Bearer '+this.token}:{})},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error('Vision service HTTP '+r.status);
  const text=await r.text();if(text.length>2*1024*1024)throw Error('Vision response too large');return JSON.parse(text);
 }
 id(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('Invalid vision job ID');return id;}
 async submit(body){const j=await this.request('/v1/vision/jobs','POST',body);this.id(j.jobId);return j;}
 status(id){return this.request('/v1/vision/jobs/'+this.id(id));}
 result(id){return this.request('/v1/vision/jobs/'+this.id(id)+'/result');}
 cancel(id){return this.request('/v1/vision/jobs/'+this.id(id),'DELETE');}
}
