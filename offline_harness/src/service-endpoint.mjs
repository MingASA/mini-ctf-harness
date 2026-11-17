import net from 'node:net';
export function validateServiceUrl(value,{allowLoopback=true}={}) {
 const url=new URL(value),host=url.hostname.replace(/^\[|\]$/g,'');
 const loop=host==='localhost'||host==='::1'||(net.isIP(host)===4&&host.startsWith('127.'));
 const p=host.split('.').map(Number);
 const private4=net.isIP(host)===4&&(p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168));
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||(!private4&&!(loop&&allowLoopback)))
  throw Error('Service endpoint must be an explicit private LAN IP or permitted loopback URL, without credentials/query/fragment');
 return url;
}
