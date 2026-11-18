import fs from 'node:fs';
import path from 'node:path';
import {hash} from './store.mjs';

const MiB=1024**2;
export const RAM_KV_LIMIT_DEFAULTS=Object.freeze({
 reserveMiB:2048,
 cpuProjectorReserveMiB:1280,
 maxCacheMiB:undefined,
});

export function ramKvLimits(policy={}, {defaults=true}={}) {
 const limits=defaults?{...RAM_KV_LIMIT_DEFAULTS}:{};
 for(const name of Object.keys(RAM_KV_LIMIT_DEFAULTS)){
  const value=policy[name];
  if(value===undefined)continue;
  if(!Number.isSafeInteger(value)||value<0)throw Error(`${name} must be a nonnegative integer MiB`);
  limits[name]=value;
 }
 return limits;
}

// Full-attention Q8_0 rows and an allowance for live recurrent state plus two checkpoints.
const profiles={
 'qwen3.8-27b-iq4xs':{bytesPerToken:34816,stateMiB:512,measuredStateMiB:450,weightBytes:14252845984,prefillTokensPerSecond:520,cpuImageSeconds:18},
 'qwen3.5-9b-ctf-web-q8':{bytesPerToken:17408,stateMiB:192,measuredStateMiB:151,weightBytes:9786060032,prefillTokensPerSecond:1150,cpuImageSeconds:18},
};

export function ramKvLocation(runtimeRoot) {
 const directory=path.join('/dev/shm',`mini-ctf-kv-${process.getuid()}-${hash(runtimeRoot).slice(0,16)}`);
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const stat=fs.lstatSync(directory);
 if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o077)||fs.statfsSync(directory).type!==0x01021994)
  throw Error('KV snapshot directory must be private tmpfs');
 return directory;
}

export function ramKvProfile(id,kvType,weightBytes,contextTokens) {
 const spec=profiles[id.replace(/-vision$/,'')];
 if(!spec||kvType!=='q8_0'||weightBytes!==spec.weightBytes||contextTokens>55296)return null;
 return spec;
}

export function admitRamKv({directory,stage,availableMiB,vision,phase,bytes,
 reserveMiB=RAM_KV_LIMIT_DEFAULTS.reserveMiB,cpuProjectorReserveMiB=RAM_KV_LIMIT_DEFAULTS.cpuProjectorReserveMiB,maxCacheMiB}) {
 const {bavail,bsize}=fs.statfsSync(directory);
 const transientMiB=512;
 const requiredMiB=reserveMiB+(vision?cpuProjectorReserveMiB:0)+transientMiB+(phase==='save'?Math.ceil(bytes/MiB):0);
 if(!Number.isFinite(availableMiB)||availableMiB<requiredMiB)
  throw Error(`RAM available ${Math.floor(availableMiB)} MiB; ${requiredMiB} MiB needed with workspace and reserve`);
 if(phase==='save'&&bavail*bsize<bytes)throw Error('Insufficient tmpfs space for the KV snapshot');
 if(maxCacheMiB!==undefined&&phase==='save'){
  const used=fs.readdirSync(directory,{withFileTypes:true})
   .filter(entry=>entry.isFile()&&entry.name.endsWith('.bin'))
   .reduce((total,entry)=>total+fs.statSync(path.join(directory,entry.name)).size,0);
  if(used+bytes>maxCacheMiB*MiB)throw Error('RAM KV snapshot would exceed maxCacheMiB');
 }
 if(stage){
  const {bavail:diskBlocks,bsize:diskBlockSize}=fs.statfsSync(stage);
  if(diskBlocks*diskBlockSize<bytes)throw Error('Insufficient data-drive space for KV staging');
 }
}

export function availableRamMiB(readWindows) {
 const linux=Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1])/1024;
 return readWindows?Math.min(linux,readWindows()):linux;
}

export function estimateRamKv(spec,tokens) {
 return Math.ceil((spec.stateMiB*MiB+tokens*(spec.bytesPerToken+32))/MiB)*MiB;
}

export function worthSaving({tokens,sharedTokens,bytes,roundTripMiBps,prefillTokensPerSecond,imageSeconds=0,admissionSeconds=2}) {
 const avoidedSeconds=Math.max(0,tokens-sharedTokens)/prefillTokensPerSecond+imageSeconds;
 const transferSeconds=bytes/MiB/roundTripMiBps;
 return avoidedSeconds>transferSeconds*1.10+admissionSeconds;
}
