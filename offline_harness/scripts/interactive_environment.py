#!/usr/bin/env python3
"""Manage this installation's Docker daemon and task containers."""
import argparse,fcntl,hashlib,ipaddress,json,os,pathlib,re,shlex,shutil,subprocess,uuid,time

def call(argv,env=None,timeout=120):
    result=subprocess.run(list(map(str,argv)),text=True,capture_output=True,env=env,timeout=timeout)
    if result.returncode:raise subprocess.CalledProcessError(result.returncode,argv,output=result.stdout,stderr=result.stderr)
    return result.stdout.strip()
def atomic(file,value):
    file=pathlib.Path(file);file.parent.mkdir(parents=True,exist_ok=True);tmp=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');os.replace(tmp,file)
class Environment:
    def __init__(self,config):
        self.c=config;self.r=config['runtime'];self.root=pathlib.Path(self.r['root']).resolve()
        if call(['findmnt','-n','-o','FSTYPE','-T',self.root.parent]) in ('9p','drvfs','ntfs','fuseblk'):raise ValueError('Docker workspace needs a native Linux filesystem')
        self.bin=self.r['docker'];self.host=self.r.get('dockerHost','unix://'+str(self.root/'run/docker.sock'));self.env=dict(os.environ,DOCKER_HOST=self.host,DOCKER_CONFIG=str(self.root/'docker-config'),TMPDIR=str(self.root/'tmp'))
    def docker(self,*args,timeout=120):return call([self.bin,*args],self.env,timeout)
    def prepare(self,daemon_only=False):
        for name in ['run','data','exec','tmp','docker-config']:(self.root/name).mkdir(parents=True,exist_ok=True)
        pathlib.Path(self.r.get('execRoot',str(self.root.parent/'dx'))).mkdir(parents=True,exist_ok=True)
        atomic(self.root/'docker-config/config.json',{'cliPluginsExtraDirs':[str(self.r.get('pluginDir',pathlib.Path(self.bin).parent/'cli-plugins'))]})
        os.chown(self.root/'docker-config',self.c['uid'],self.c['gid']);os.chown(self.root/'docker-config/config.json',self.c['uid'],self.c['gid'])
        daemon={'data-root':str(self.root/'data'),'exec-root':str(self.r.get('execRoot',str(self.root.parent/'dx'))),'pidfile':str(self.root/'run/dockerd.pid'),'hosts':[self.host],'group':str(self.c['uid']),'storage-driver':'overlay2','bridge':'none','features':{'containerd-snapshotter':False},'log-driver':'local','log-opts':{'max-size':'10m','max-file':'2'}}
        file=self.root/'daemon.json'
        if not self.r.get('dockerHost') and file.exists() and json.loads(file.read_text())!=daemon:raise ValueError('Existing interactive daemon profile differs')
        if not self.r.get('dockerHost'):atomic(file,daemon)
        try:info=json.loads(self.docker('info','--format','{{json .}}',timeout=10))
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):
            if self.r.get('dockerHost'):raise RuntimeError('Configured external Docker daemon is unavailable')
            unit='mini-ctf-docker-'+hashlib.sha256(str(self.root).encode()).hexdigest()[:10]
            if subprocess.run(['systemctl','is-active','--quiet',unit+'.service']).returncode!=0:
                subprocess.run(['systemctl','reset-failed',unit+'.service'],capture_output=True)
                call(['systemd-run','--unit='+unit,'--property=Type=exec','--property=Restart=no','--property=StandardOutput=append:'+str(self.root/'daemon.log'),'--property=StandardError=append:'+str(self.root/'daemon.log'),'--setenv=PATH='+str(pathlib.Path(self.r['dockerd']).parent)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','--setenv=TMPDIR='+str(self.root/'tmp'),self.r['dockerd'],'--config-file',file])
            for _ in range(60):
                try:info=json.loads(self.docker('info','--format','{{json .}}',timeout=3));break
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired):time.sleep(.5)
            else:raise RuntimeError('Docker did not become ready; see '+str(self.root/'daemon.log'))
        if not self.r.get('dockerHost') and info.get('DockerRootDir')!=str(self.root/'data'):raise ValueError('Docker data-root identity mismatch')
        if daemon_only:return {'ready':True,'docker':self.bin,'dockerHost':self.host}
        try:image=json.loads(self.docker('image','inspect',self.r['solverImage']))[0]
        except subprocess.CalledProcessError:self.docker('image','load','--input',self.r['solverArchive'],timeout=900);image=json.loads(self.docker('image','inspect',self.r['solverImage']))[0]
        if image['Id']!=self.r['solverImage']:raise ValueError('Loaded solver identity mismatch')
        for env in self.c.get('environments',{}).values():
            if env['type']=='internal':self.network(env['network'],True,env['subnet'])
            elif env['type']=='lan':self.network(env.get('network','ctf-front-lan'),False,env.get('subnet','172.30.90.0/24'))
        tools=self.docker('run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--pids-limit','64',image['Id'],'python3','-c',"import json,shutil; tools={n:shutil.which(n) for n in ['python3','curl','bash','file']}; print(json.dumps(tools)); assert all(tools.values()), tools")
        return {'ready':True,'docker':self.bin,'dockerHost':self.host,'imageId':image['Id'],'tools':json.loads(tools),'dataRoot':info['DockerRootDir']}
    def network(self,name,internal,subnet):
        try:n=json.loads(self.docker('network','inspect',name))[0]
        except subprocess.CalledProcessError:
            args=['network','create','--driver','bridge','--subnet',subnet,'--label','qwen.contest.egress=managed','--opt','com.docker.network.bridge.name=ctf-'+hashlib.sha256(name.encode()).hexdigest()[:10]]
            if internal:args.append('--internal')
            self.docker(*args,name);n=json.loads(self.docker('network','inspect',name))[0]
        if n['Driver']!='bridge' or bool(n['Internal'])!=internal or n['IPAM']['Config'][0]['Subnet']!=subnet:raise ValueError('Environment network differs from config')
        return n
    def environment(self,name):
        env=self.c.get('environments',{}).get(name)
        if not env:raise ValueError('Unknown environment '+name)
        if env['type']=='internal':
            self.network(env['network'],True,env['subnet'])
            for archive in env.get('imageArchives',[]):self.docker('image','load','--input',archive,timeout=900)
            if env.get('composeFile'):self.docker('compose','-f',str(pathlib.Path(env['composeFile']).resolve(strict=True)),'-p','ctf-front-'+re.sub('[^a-z0-9-]','-',name.lower()),'up','-d','--pull','never','--no-build','--wait','--wait-timeout','120',timeout=180)
        return env
    def provision(self,task,work_dir,environment,target):
        if not re.fullmatch('[A-Za-z0-9_-]{1,100}',task):raise ValueError('Invalid task ID')
        base=pathlib.Path(self.c['provision']['workBase']).resolve();work=pathlib.Path(work_dir).resolve(strict=True)
        if '/offline-harness/work' not in str(base) or work==base or not work.is_relative_to(base):raise ValueError('Invalid task work path')
        env=self.environment(environment);kind=env['type'];network=None;source=None
        if kind=='offline' and target:kind='lan'
        if kind=='internal':network=self.network(env['network'],True,env['subnet'])
        elif kind=='lan':
            from urllib.parse import urlsplit
            address=ipaddress.ip_address(urlsplit(target or env.get('targetUrl','')).hostname or '')
            if address.version!=4 or not any(address in ipaddress.ip_network(n) for n in ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']):raise ValueError('LAN target needs an explicit private IPv4 URL')
            allowed=env.get('allowedCidrs',[str(address)+'/32']);subnet=env.get('subnet','172.30.90.0/24')
            network=self.network(env.get('network','ctf-front-lan'),False,subnet);used={item['IPv4Address'].split('/')[0] for item in network.get('Containers',{}).values()}
            for policy_file in (self.root/'policies').glob('*.json') if (self.root/'policies').exists() else []:
                prior=json.loads(policy_file.read_text());used.add(prior['sourceIp'])
            source=next((str(ip) for ip in list(ipaddress.ip_network(subnet).hosts())[1:] if str(ip) not in used),None)
            if not source:raise RuntimeError('LAN solver subnet has no free address')
        elif kind!='offline':raise ValueError('Unknown environment type')
        limits=self.c.get('solver',{});memory=int(limits.get('memoryMiB',2048));pids=int(limits.get('pids',128));tmp=int(limits.get('tmpMiB',128))
        if not 128<=memory<=4096 or not 32<=pids<=256 or not 16<=tmp<=512:raise ValueError('Solver resource configuration is out of range')
        os.chown(work,self.c['uid'],self.c['gid'])
        args=['create','--pull=never','--name','ctf-front-'+task+'-'+uuid.uuid4().hex[:8],'--label','qwen.interactive=true','--network',network['Id'] if network else 'none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',str(self.c['uid'])+':'+str(self.c['gid']),'--memory',str(memory)+'m','--memory-swap',str(memory)+'m','--cpus',str(limits.get('cpus',1)),'--pids-limit',str(pids),'--tmpfs','/tmp:rw,nosuid,nodev,size='+str(tmp)+'m','--mount','type=bind,src='+str(work)+',dst=/work','--workdir','/work']
        if network:args.extend(['--dns','127.0.0.1'])
        if source:args.extend(['--ip',source,'--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1'])
        cid=self.docker(*args,self.r['solverImage'],'sleep','infinity');receipt={'docker':self.bin,'dockerHost':self.host,'containerId':cid,'imageId':self.r['solverImage'],'workDir':str(work)}
        if kind=='lan':
            host_ips=sorted({v['local'] for i in json.loads(call(['ip','-j','-4','address','show'])) for v in i['addr_info'] if v['family']=='inet'})
            policy={'version':1,'containerId':cid,'networkId':network['Id'],'bridge':network['Options']['com.docker.network.bridge.name'],'sourceIp':source,'solverSubnet':subnet,'allowedCidrs':allowed,'hostIps':host_ips}
            policy_file=self.root/'policies'/(cid+'.json');atomic(policy_file,policy);digest=hashlib.sha256(policy_file.read_bytes()).hexdigest();guard=pathlib.Path(__file__).with_name('network_guard.py')
            # A scoped legacy filter hook also runs when Docker uses native nft rules.
            # Do not flush, translate or replace any existing nftables rules.
            snapshot=call(['/usr/sbin/iptables-legacy-save','-t','filter'])
            if ':DOCKER-USER ' not in snapshot:
                if any(line.startswith('-A FORWARD ') for line in snapshot.splitlines()):raise ValueError('Existing legacy forwarding rules need explicit network configuration')
                call(['/usr/sbin/iptables-legacy','-N','DOCKER-USER']);call(['/usr/sbin/iptables-legacy','-I','FORWARD','1','-j','DOCKER-USER'])
            args=['--policy',str(policy_file),'--expect-sha256',digest,'--docker',self.bin,'--docker-host',self.host,'--iptables','/usr/sbin/iptables-legacy','--iptables-save','/usr/sbin/iptables-legacy-save'];call(['python3',guard,'apply','--apply',*args])
            helper=self.root/'policies'/(cid+'-verify');command=['sudo','-n','python3',str(guard),'verify',*args]
            if self.c.get('wslDistribution'):command=['/mnt/c/Windows/System32/wsl.exe','--distribution',self.c['wslDistribution'],'--user','root','--exec','nsenter','--mount=/proc/1/ns/mnt','--','python3',str(guard),'verify',*args]
            helper.write_text('#!/bin/sh\ncd '+shlex.quote(self.c.get('hostCwd','/'))+'\nexec '+' '.join(map(shlex.quote,command))+'\n');helper.chmod(0o755);receipt['egress']={'mode':'lan','policyFile':str(policy_file),'policySha256':digest,'verifyExecutable':str(helper)}
        self.docker('start',cid);atomic(self.root/'sandboxes'/(task+'.json'),receipt);return receipt
    def deprovision(self,task,work_dir,container_id):
        if not re.fullmatch('[A-Za-z0-9_-]{1,100}',task):raise ValueError('Invalid task ID')
        if not re.fullmatch('[0-9a-f]{64}',container_id or ''):raise ValueError('Full container identity required')
        base=pathlib.Path(self.c['provision']['workBase']).resolve();work=pathlib.Path(work_dir).resolve(strict=True)
        if '/offline-harness/work' not in str(base) or work!=base/task or not work.is_relative_to(base):raise ValueError('Invalid task work path')
        receipt_file=self.root/'sandboxes'/(task+'.json')
        if not receipt_file.is_file() or receipt_file.is_symlink():raise ValueError('Managed sandbox receipt is missing')
        receipt=json.loads(receipt_file.read_text())
        if receipt.get('containerId')!=container_id or pathlib.Path(receipt.get('workDir','')).resolve()!=work:raise ValueError('Sandbox receipt identity mismatch')
        container=json.loads(self.docker('inspect',container_id))[0]
        if container.get('Id')!=container_id or container.get('Image')!=receipt.get('imageId') or container.get('Config',{}).get('Labels',{}).get('qwen.interactive')!='true':raise ValueError('Container is not the recorded managed solver')
        mounts=container.get('Mounts',[])
        if len(mounts)!=1 or mounts[0].get('Type')!='bind' or pathlib.Path(mounts[0].get('Source','')).resolve()!=work or mounts[0].get('Destination')!='/work':raise ValueError('Solver bind mount identity mismatch')
        if container.get('State',{}).get('Running'):self.docker('stop','--time','10',container_id)
        egress=receipt.get('egress')
        if egress:
            policy=pathlib.Path(egress.get('policyFile',''))
            helper=pathlib.Path(egress.get('verifyExecutable',''))
            if policy.parent!=self.root/'policies' or helper.parent!=self.root/'policies':raise ValueError('LAN policy path is outside the managed directory')
            guard=pathlib.Path(__file__).with_name('network_guard.py')
            args=['--policy',str(policy),'--expect-sha256',egress['policySha256'],'--docker',self.bin,'--docker-host',self.host,'--iptables','/usr/sbin/iptables-legacy','--iptables-save','/usr/sbin/iptables-legacy-save']
            call(['python3',guard,'remove','--remove',*args])
        self.docker('rm',container_id)
        if egress:
            policy.unlink();helper.unlink(missing_ok=True)
        receipt_file.unlink();shutil.rmtree(work)
        return {'deleted':True,'task':task,'containerId':container_id,'workDir':str(work)}

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['daemon','prepare','environment','provision','deprovision']);p.add_argument('--config',required=True);p.add_argument('--task');p.add_argument('--work-dir');p.add_argument('--container-id');p.add_argument('--environment',default='offline');p.add_argument('--target',default='');a=p.parse_args()
    if os.geteuid()!=0:raise SystemExit('Use the configured operator WSL root entry point')
    env=Environment(json.loads(pathlib.Path(a.config).read_text()));env.root.mkdir(parents=True,exist_ok=True)
    with (env.root/'operator.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX);result=env.prepare(daemon_only=a.action=='daemon') if a.action in ('daemon','prepare') else env.environment(a.environment) if a.action=='environment' else env.deprovision(a.task,a.work_dir,a.container_id) if a.action=='deprovision' else env.provision(a.task,a.work_dir,a.environment,a.target)
    print(json.dumps(result))
if __name__=='__main__':
    try:main()
    except subprocess.CalledProcessError as error:
        print(error.stderr or error.stdout or str(error),file=sys.stderr);raise SystemExit(error.returncode)
