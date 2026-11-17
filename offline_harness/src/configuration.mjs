// Explicit operator migration at a stopped task. Original configuration events
// remain in the journal; normal resumes still reject unreviewed config changes.
import fs from 'node:fs';
import path from 'node:path';
import {hash} from './store.mjs';
import {processIdentity} from './task-clock.mjs';
import {ContextManager} from './context.mjs';

const fields=['contextTokens','promptTokens','compactSoftTokens','compactHardTokens','compactTokens','generationTokens','safetyTokens'];
export function migrateContextBudget(store,next,reason){
 if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw Error('Explicit bounded migration reason required');
 const previous=store.events.findLast(e=>e.type==='configuration');
 if(!previous||previous.data.sha256!==hash(JSON.stringify(previous.data.config)))throw Error('Missing valid frozen configuration');
 if(store.pending().length)throw Error('Uncertain tool outcome blocks migration');
 const ownerFile=path.join(store.root,'owner.json');
 if(fs.existsSync(ownerFile)){
  const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8'));
  const live=processIdentity(owner.pid);if(live&&live.state!=='Z')throw Error('Live runner blocks migration');
 }
 for(const e of store.events.filter(e=>e.type==='solve_segment_start')){
  const live=processIdentity(e.data.owner.pid);
  if(live?.state!=='Z'&&live?.start_ticks===e.data.owner.start_ticks&&!store.events.some(x=>x.type==='solve_segment_end'&&x.data.start_seq===e.seq))throw Error('Live solve interval blocks migration');
 }
 const old=previous.data.config,changed=[...new Set([...Object.keys(old),...Object.keys(next)])].filter(k=>JSON.stringify(old[k])!==JSON.stringify(next[k]));
 if(changed.some(k=>!fields.includes(k)))throw Error('Only context token allocation may migrate');
 if(!Number.isInteger(next.contextTokens)||next.contextTokens>old.contextTokens)throw Error('Context migration must not increase the engine window');
 const {hard,margin}=new ContextManager(store,next).limits();
 if(hard!==null&&hard+Math.max(next.generationTokens,next.compactTokens??4096)+margin>next.contextTokens)throw Error('Insufficient hard-boundary output reserve');
 if(!changed.length)return previous;
 return store.append('configuration',{sha256:hash(JSON.stringify(next)),config:next,previous_sha256:previous.data.sha256,migration_type:'operator_context_reduction',reason,changed_fields:changed});
}
