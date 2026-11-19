import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLanPolicy,validateNetworkPolicy,verifyEgress} from '../src/network-policy.mjs';

const helper=fileURLToPath(new URL('../scripts/network_guard.py',import.meta.url));
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const basePolicy=()=>({version:1,containerId:'a'.repeat(64),networkId:'b'.repeat(64),bridge:'ctf-test',sourceIp:'172.30.90.2',solverSubnet:'172.30.90.0/24',allowedCidrs:['192.168.50.20/32'],hostIps:['127.0.0.1','172.30.90.1','192.168.50.10']});
function fixture(t, change=()=>{}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'network-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const workDir=path.join(dir,'work');fs.mkdirSync(workDir);
  const p=basePolicy();change(p);const raw=JSON.stringify(p);const file=path.join(dir,'policy.json');fs.writeFileSync(file,raw);
  const config={containerId:p.containerId,workDir,egress:{mode:'lan',policyFile:file,policySha256:digest(raw)}};
  const container={Id:p.containerId,State:{Running:true},Config:{Env:[]},HostConfig:{NetworkMode:'contest',Dns:['127.0.0.1'],Sysctls:{'net.ipv6.conf.all.disable_ipv6':'1','net.ipv6.conf.default.disable_ipv6':'1'},CapDrop:['ALL']},NetworkSettings:{Networks:{contest:{NetworkID:p.networkId,IPAddress:p.sourceIp,GlobalIPv6Address:''}}}};
  const network={Id:p.networkId,Driver:'bridge',Internal:false,EnableIPv6:false,Labels:{'qwen.contest.egress':'managed'},Options:{'com.docker.network.bridge.name':p.bridge},IPAM:{Config:[{Subnet:p.solverSubnet}]}};
  return {p,config,container,network};
}
function python(code, data={}) {
  const source=`import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('guard',sys.argv[1])\ng=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)\ndata=json.load(sys.stdin)\n${code}`;
  return JSON.parse(execFileSync('python3',['-c',source,helper],{input:JSON.stringify(data),encoding:'utf8'}));
}
const simulation=String.raw`
def snapshot(chains):
    text='*filter\n'
    for name in chains:
        text+=':'+name+(' ACCEPT' if name in ('INPUT','FORWARD','OUTPUT') else ' -')+' [0:0]\n'
    for name,rules in chains.items():
        for rule in rules:
            text+='-A '+name+' '+' '.join(rule)+'\n'
    return text+'COMMIT\n'
def base():
    return {'INPUT':[['-j','ACCEPT']],'FORWARD':[['-j','DOCKER-USER'],['-j','ACCEPT']],'OUTPUT':[], 'DOCKER-USER':[['-j','RETURN']]}
def install(chains,commands):
    for command in commands:
        op,name,*rest=command
        if op=='-N': chains[name]=[]
        elif op=='-A': chains[name].append(rest)
        elif op=='-I': chains[name].insert(int(rest[0])-1,rest[1:])
        else: raise AssertionError('Unexpected mutation '+op)
def rejected(fn):
    try: fn()
    except (ValueError,TypeError): return True
    return False
p=data['policy']
`;

test('none and internal bridge modes preserve offline operation',()=>{
  assert.equal(validateNetworkPolicy({HostConfig:{NetworkMode:'none'}},[],{}).mode,'none');
  assert.equal(validateNetworkPolicy({HostConfig:{NetworkMode:'private',Dns:['127.0.0.1']}},[{Driver:'bridge',Internal:true}],{}).mode,'internal');
  assert.throws(()=>validateNetworkPolicy({HostConfig:{NetworkMode:'host'}},[],{}));
  assert.throws(()=>validateNetworkPolicy({HostConfig:{NetworkMode:'private',Dns:['8.8.8.8']}},[{Driver:'bridge',Internal:true}],{}));
});
test('LAN requires pinned policy and exact dedicated endpoint',t=>{
  const {p,container,network,config}=fixture(t);
  assert.deepEqual(readLanPolicy(config),p);
  assert.equal(validateNetworkPolicy(container,[network],config).mode,'lan');
  for(const mutate of [c=>c.NetworkSettings.Networks.contest.IPAddress='172.30.90.3',c=>c.HostConfig.Sysctls={},c=>c.Config.Env=['HTTPS_PROXY=http://192.168.50.20'],c=>c.NetworkSettings.Networks.other={},c=>c.NetworkSettings.Networks.contest.GlobalIPv6Address='fd00::2']){
    const c=structuredClone(container);mutate(c);assert.throws(()=>validateNetworkPolicy(c,[network],config));
  }
  fs.appendFileSync(config.egress.policyFile,' ');assert.throws(()=>readLanPolicy(config),/digest/);
});
test('public targets, bridge overlap, unknown fields, model-writable policy reject',t=>{
  for(const change of [p=>p.allowedCidrs=['8.8.8.8/32'],p=>p.allowedCidrs=['172.30.90.0/24'],p=>p.allowedCidrs=['192.168.50.1/24'],p=>p.extra=true,p=>p.sourceIp='172.30.90.0']){
    const {config}=fixture(t,change);assert.throws(()=>readLanPolicy(config));
  }
  const {config}=fixture(t);const dest=path.join(config.workDir,'policy.json');fs.copyFileSync(config.egress.policyFile,dest);config.egress.policyFile=dest;assert.throws(()=>readLanPolicy(config),/solver-writable/);
});
test('live verifier uses read-only CLI and rejects mismatched receipts',async t=>{
  const {p,config}=fixture(t);let calls=0;
  const receipt={verified:true,policySha256:config.egress.policySha256,containerId:p.containerId,networkId:p.networkId,sourceIp:p.sourceIp,bridge:p.bridge,rulesSha256:'c'.repeat(64)};
  const execute=async(command,args,opts)=>{calls++;assert.equal(command,'python3');assert.equal(args[0],helper);assert.equal(args[1],'verify');assert(!args.includes('--apply'));assert.equal(opts.env.DOCKER_HOST,'unix:///var/run/docker.sock');return {stdout:JSON.stringify(receipt)};};
  await verifyEgress(config,execute);await verifyEgress(config,execute);assert.equal(calls,2);
  await assert.rejects(verifyEgress(config,async()=>({stdout:JSON.stringify({...receipt,sourceIp:'172.30.90.3'})})),/did not match/);
  await assert.rejects(verifyEgress({...config,dockerHost:'tcp://remote:2375'},execute),/local Linux/);
});
test('dry-run is standalone and apply requires a second explicit flag',t=>{
  const {config}=fixture(t);
  const result=JSON.parse(execFileSync('python3',[helper,'plan','--policy',config.egress.policyFile,'--docker','/does-not-exist','--iptables-save','/does-not-exist'],{encoding:'utf8'}));
  assert.equal(result.applied,false);assert.match(result.note,/No Docker/);
  assert.throws(()=>execFileSync('python3',[helper,'apply','--policy',config.egress.policyFile],{stdio:'pipe'}),e=>e.status===1 && /both apply and --apply/.test(e.stderr.toString()));
});
test('synthetic installation is scoped, preserves unrelated rules and is idempotent',()=>{
  const result=python(simulation+String.raw`
c=base(); commands=g.plan_install(p,snapshot(c)); install(c,commands)
receipt=g.verify_saved_rules(p,snapshot(c))
assert c['INPUT'][1:]==[['-j','ACCEPT']]
assert c['FORWARD']==base()['FORWARD']
assert all(command[0] in ('-N','-A','-I') for command in commands)
assert all(command[1].startswith('QCTF_') or command[:3] in (['-I','INPUT','1'],['-I','DOCKER-USER','1']) for command in commands)
assert g.plan_install(p,snapshot(c))==[]
# Real iptables-save puts -s before -i and ctstate before other conntrack options.
for name in (g.DISPATCH,g.HOST_INPUT):
    c[name][0]=c[name][0][2:4]+c[name][0][:2]+c[name][0][4:]
for rule in c[receipt['chain']]:
    if '--ctstate' in rule:
        index=rule.index('--ctstate'); pair=rule[index:index+2];del rule[index:index+2];rule[rule.index('--ctorigdst'):rule.index('--ctorigdst')]=pair
        rule[rule.index('--ctstate')+1]='ESTABLISHED,NEW'
g.verify_saved_rules(p,snapshot(c))
print(json.dumps({'commands':len(commands),'verified':True}))
`,{policy:basePolicy()});assert(result.verified);assert(result.commands>5);
});
test('synthetic firewall tampering and hook bypass fail closed',()=>{
  const result=python(simulation+String.raw`
import copy
c=base();install(c,g.plan_install(p,snapshot(c))); chain=g.chain_name(p)
changes=[lambda x:x['FORWARD'].insert(0,['-j','ACCEPT']),lambda x:x['INPUT'].insert(0,['-j','ACCEPT']),lambda x:x['DOCKER-USER'].insert(0,['-j','RETURN']),lambda x:x[g.DISPATCH].insert(0,['-j','RETURN']),lambda x:x[chain].pop(),lambda x:x[chain].insert(0,['-j','ACCEPT']),lambda x:x[g.HOST_INPUT].clear(),lambda x:x[g.DISPATCH].append(x[g.DISPATCH][0])]
for change in changes:
    candidate=copy.deepcopy(c);change(candidate);assert rejected(lambda:g.verify_saved_rules(p,snapshot(candidate)))
# Replacing original-destination guard would permit a DNAT bypass.
candidate=copy.deepcopy(c)
for rule in candidate[chain]:
    if '--ctdir' in rule:
        index=rule.index('--ctorigdst');del rule[index:index+2];break
assert rejected(lambda:g.verify_saved_rules(p,snapshot(candidate)))
# Multiple disjoint solver scopes can share hooks without modifying older guards.
p2={**p,'containerId':'d'*64,'sourceIp':'172.30.90.3'}
install(c,g.plan_install(p2,snapshot(c)))
g.verify_saved_rules(p,snapshot(c));g.verify_saved_rules(p2,snapshot(c))
p3={**p,'allowedCidrs':['192.168.50.21/32']}
assert rejected(lambda:g.plan_install(p3,snapshot(c)))
print(json.dumps({'tamperCases':len(changes)+2,'secondSolver':True}))
`,{policy:basePolicy()});assert.equal(result.tamperCases,10);assert(result.secondSolver);
});
test('synthetic removal deletes only the selected policy and drops shared hooks when empty',()=>{
  const result=python(simulation+String.raw`
def remove(chains,commands):
    for command in commands:
        op,name,*rest=command
        if op=='-D': chains[name].remove(rest)
        elif op=='-F': chains[name].clear()
        elif op=='-X': del chains[name]
        else: raise AssertionError('Unexpected removal '+op)
c=base();p2={**p,'containerId':'d'*64,'sourceIp':'172.30.90.3'}
install(c,g.plan_install(p,snapshot(c)));install(c,g.plan_install(p2,snapshot(c)))
commands=g.plan_remove(p,snapshot(c));remove(c,commands)
assert g.plan_remove(p,snapshot(c))==[]
g.verify_saved_rules(p2,snapshot(c))
assert g.chain_name(p) not in c and g.DISPATCH in c and g.HOST_INPUT in c
remove(c,g.plan_remove(p2,snapshot(c)))
assert g.DISPATCH not in c and g.HOST_INPUT not in c
assert c['INPUT']==base()['INPUT'] and c['DOCKER-USER']==base()['DOCKER-USER']
print(json.dumps({'firstCommands':len(commands),'clean':True}))
`,{policy:basePolicy()});assert(result.clean);assert(result.firstCommands>=4);
});
test('topology verification rejects changed host IPs, DNS, bridge filtering and privileges',t=>{
  const f=fixture(t);
  const result=python(simulation+String.raw`
import copy
container=data['container'];net=data['network'];addresses=[{'addr_info':[{'family':'inet','local':x} for x in p['hostIps']]}];link=[{'ifname':p['bridge'],'linkinfo':{'info_kind':'bridge'}}]
g.validate_topology(p,container,net,addresses,link,'1')
assert rejected(lambda:g.validate_topology(p,container,net,addresses+ [{'addr_info':[{'family':'inet','local':'10.0.0.1'}]}],link,'1'))
assert rejected(lambda:g.validate_topology(p,container,net,addresses,link,'0'))
for key,value in [('Dns',['8.8.8.8']),('Privileged',True),('CapAdd',['NET_ADMIN']),('CapDrop',[]),('PortBindings',{'80/tcp':[{}]})]:
    c=copy.deepcopy(container);c['HostConfig'][key]=value;assert rejected(lambda:g.validate_topology(p,c,net,addresses,link,'1'))
print(json.dumps({'rejected':7}))
`,{policy:f.p,container:f.container,network:f.network});assert.equal(result.rejected,7);
});
