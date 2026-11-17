import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/network_guard.py',import.meta.url));
const sha256 = value=>crypto.createHash('sha256').update(value).digest('hex');
const fail = message=>{throw Error(message);};
function ip(value) {
  if(typeof value!=='string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value))fail('Canonical IPv4 required');
  const values=value.split('.').map(Number);if(values.some(n=>n>255))fail('Invalid IPv4');
  return values.reduce((n,v)=>n*256+v,0);
}
function cidr(value) {
  if(typeof value!=='string' || !/^.+\/(0|[1-9]\d?)$/.test(value))fail('Canonical IPv4 CIDR required');
  const [address,bits]=value.split('/'),prefix=Number(bits),number=ip(address);
  if(prefix>32)fail('Invalid CIDR prefix');
  const width=2**(32-prefix),start=Math.floor(number/width)*width;
  if(start!==number)fail('CIDR must name a network boundary');
  const end=start+width-1;
  if(![[ip('10.0.0.0'),ip('10.255.255.255')],[ip('172.16.0.0'),ip('172.31.255.255')],[ip('192.168.0.0'),ip('192.168.255.255')]].some(([a,b])=>start>=a&&end<=b))fail('Only explicit RFC1918 targets are supported');
  return {start,end,prefix};
}
export function readLanPolicy(config) {
  const e=config.egress;
  if(e?.mode!=='lan' || !path.isAbsolute(e.policyFile||'') || !/^[a-f0-9]{64}$/.test(e.policySha256||''))fail('LAN egress needs an absolute policy file and pinned SHA256');
  if(fs.lstatSync(e.policyFile).isSymbolicLink())fail('Policy symlinks are not permitted');
  const real=fs.realpathSync(e.policyFile),work=config.workDir && fs.realpathSync(config.workDir);
  if(work && (real===work || real.startsWith(work+path.sep)))fail('Network policy cannot be solver-writable');
  const raw=fs.readFileSync(real);
  if(raw.length>65536 || sha256(raw)!==e.policySha256)fail('LAN policy digest changed');
  const p=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  const fields=['version','containerId','networkId','bridge','sourceIp','solverSubnet','allowedCidrs','hostIps'];
  if(Object.keys(p).length!==fields.length || fields.some(k=>!(k in p)) || p.version!==1)fail('Unknown LAN policy fields/version');
  if(!/^[a-f0-9]{64}$/.test(p.containerId||'') || !/^[a-f0-9]{64}$/.test(p.networkId||''))fail('Full Docker identities required');
  if(!/^ctf-[a-z0-9-]{1,11}$/.test(p.bridge||''))fail('Dedicated ctf-* bridge required');
  const source=ip(p.sourceIp),subnet=cidr(p.solverSubnet);
  if(source<=subnet.start || source>=subnet.end)fail('Solver IP must be usable in its declared subnet');
  if(!Array.isArray(p.allowedCidrs) || !p.allowedCidrs.length || p.allowedCidrs.length>64 || new Set(p.allowedCidrs).size!==p.allowedCidrs.length)fail('Declare unique target CIDRs');
  for(const value of p.allowedCidrs){const net=cidr(value);if(net.start<=subnet.end&&net.end>=subnet.start)fail('Targets overlap solver bridge');}
  if(!Array.isArray(p.hostIps) || !p.hostIps.length || p.hostIps.length>128 || new Set(p.hostIps).size!==p.hostIps.length)fail('Declare unique host IPv4 addresses');
  p.hostIps.forEach(ip);if(p.hostIps.includes(p.sourceIp))fail('Solver IP cannot be a host address');
  return p;
}

export function validateNetworkPolicy(container,networks,config) {
  const h=container.HostConfig||{};
  if(h.NetworkMode==='none')return {mode:'none'};
  if(h.NetworkMode==='host' || h.NetworkMode?.startsWith('container:'))fail('Host/shared namespace networking is not permitted');
  if(JSON.stringify(h.Dns)!==JSON.stringify(['127.0.0.1']))fail('External DNS forwarding is disabled');
  if(!networks.length)fail('Missing network inspection');
  if(networks.every(n=>n.Internal && n.Driver==='bridge'))return {mode:'internal'};
  if(config.egress?.mode!=='lan')fail('Sandbox network must be internal-only unless an explicit LAN policy is configured');
  const p=readLanPolicy(config),attached=Object.values(container.NetworkSettings?.Networks||{});
  if(p.containerId!==container.Id || p.containerId!==config.containerId || networks.length!==1 || attached.length!==1)fail('LAN solver network identity mismatch');
  const n=networks[0],a=attached[0];
  if(n.Id!==p.networkId || n.Driver!=='bridge' || n.Internal || n.EnableIPv6 || a.NetworkID!==p.networkId || a.IPAddress!==p.sourceIp || a.GlobalIPv6Address)fail('LAN guard requires its exact IPv4 bridge endpoint');
  if(n.Labels?.['qwen.contest.egress']!=='managed' || n.Options?.['com.docker.network.bridge.name']!==p.bridge || n.IPAM?.Config?.length!==1 || n.IPAM.Config[0].Subnet!==p.solverSubnet)fail('LAN bridge configuration differs from policy');
  if(['all','default'].some(scope=>String(h.Sysctls?.[`net.ipv6.conf.${scope}.disable_ipv6`])!=='1'))fail('IPv6 must be disabled in the solver namespace');
  if((container.Config?.Env||[]).some(e=>/^(http_proxy|https_proxy|all_proxy)=.+/i.test(e)))fail('Proxy environment variables are not permitted');
  return {mode:'lan',policy:p};
}

export async function verifyEgress(config,execute=exec) {
  const p=readLanPolicy(config),e=config.egress;
  if(config.dockerHost && !config.dockerHost.startsWith('unix:///'))fail('LAN guard supports a local Linux Docker socket only');
  const args=['verify','--policy',e.policyFile,'--expect-sha256',e.policySha256,
    '--docker',config.docker||'docker','--docker-host',config.dockerHost||'unix:///var/run/docker.sock'];
  // A root-owned operator helper may expose this same read-only CLI. Never a model tool.
  if(e.verifyExecutable){
    if(!path.isAbsolute(e.verifyExecutable))fail('Verification helper must be an absolute operator path');
    const stat=fs.lstatSync(e.verifyExecutable);
    if(!stat.isFile() || stat.uid!==0 || (stat.mode & 0o022))fail('Verification helper must be root-owned and not group/world writable');
    const real=fs.realpathSync(e.verifyExecutable),work=config.workDir&&fs.realpathSync(config.workDir);
    if(work&&(real===work||real.startsWith(work+path.sep)))fail('Verification helper cannot be solver-writable');
  }
  const command=e.verifyExecutable||'python3',argv=e.verifyExecutable?args:[script,...args];
  const result=await execute(command,argv,{timeout:30000,maxBuffer:1024*1024,
    env:{PATH:process.env.PATH,DOCKER_HOST:config.dockerHost||'unix:///var/run/docker.sock'}});
  const receipt=JSON.parse(result.stdout);
  if(receipt.verified!==true || receipt.policySha256!==e.policySha256 || receipt.containerId!==p.containerId || receipt.networkId!==p.networkId || receipt.sourceIp!==p.sourceIp || receipt.bridge!==p.bridge || !/^[a-f0-9]{64}$/.test(receipt.rulesSha256||''))fail('Live network verification did not match the pinned policy');
  return receipt;
}
