import {validateServiceUrl} from '../service-endpoint.mjs';
import {requestJson} from './adapters.mjs';

export class RagClient {
  constructor({endpoint,token,timeoutMs=15000,fetchImpl=fetch}) {
    const url=validateServiceUrl(endpoint);
    const prefix=url.pathname.replace(/\/$/,'');
    this.base=url.origin+(prefix.endsWith('/v1')?prefix:prefix+'/v1');
    Object.assign(this,{token,timeoutMs,fetchImpl});
  }
  request(suffix,{method='GET',body,signal}={}) {
    return requestJson(this.base+suffix,{method,body,signal,token:this.token,timeoutMs:this.timeoutMs,fetchImpl:this.fetchImpl});
  }
  submit(request,{signal}={}) {return this.request('/search/jobs',{method:'POST',body:request,signal});}
  status(jobId,{signal}={}) {return this.request('/search/jobs/'+this.id(jobId),{signal});}
  result(jobId,{signal}={}) {return this.request('/search/jobs/'+this.id(jobId)+'/result',{signal});}
  cancel(jobId,{signal}={}) {return this.request('/search/jobs/'+this.id(jobId),{method:'DELETE',signal});}
  read(chunkId,{signal}={}) {
    if(typeof chunkId!=='string'||!chunkId||chunkId.length>120)throw Error('Invalid evidence identifier');
    return this.request('/evidence/'+encodeURIComponent(chunkId),{signal});
  }
  id(value){if(typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value))throw Error('Invalid retrieval job ID');return value;}
}
