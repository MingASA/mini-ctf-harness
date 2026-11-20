import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CONFIG_FILE, DATA_ROOT} from '../paths.mjs';
import {assertExperimentIdle} from '../process-guard.mjs';

// Standalone readers must use a separate server. A quiet competition server can
// still hold resident KV; "not processing" is not permission to reuse it.
export function acquireReader({base, configFile = CONFIG_FILE, guard = assertExperimentIdle}) {
  guard();
  if (!fs.existsSync(configFile)) throw Error('Standalone ask requires the competition config (MINI_CTF_CONFIG) to identify protected model servers. Use knowledge search/get without a model.');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const lease = config.modelLease || path.join(DATA_ROOT, 'model-lease.json');
  fs.mkdirSync(path.dirname(lease), {recursive:true});
  const owner = {pid:process.pid, readerId:randomUUID()};
  try {fs.writeFileSync(lease, JSON.stringify(owner), {flag:'wx', mode:0o600});}
  catch (error) {if(error.code==='EEXIST')throw Error('Model lease held or stale; standalone reader will not interfere.');throw error;}
  const release = () => {
    if (fs.existsSync(lease) && JSON.parse(fs.readFileSync(lease, 'utf8')).readerId === owner.readerId) fs.unlinkSync(lease);
  };
  try {
    const protectedPorts = new Set(['8080']);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'baseUrl' && typeof child === 'string') {
          const url = new URL(child);
          if (['127.0.0.1','localhost','[::1]'].includes(url.hostname)) protectedPorts.add(url.port || (url.protocol==='https:'?'443':'80'));
        } else visit(child);
      }
    };
    visit(config);
    if (config.contestDir) {
      const selection = path.join(config.contestDir, 'model-selection.json');
      if (fs.existsSync(selection)) visit(JSON.parse(fs.readFileSync(selection, 'utf8')));
    }
    if (protectedPorts.has(base.port || (base.protocol==='https:'?'443':'80'))) throw Error('Standalone ask requires a separate model endpoint; this port belongs to a competition server and may hold resident KV. Use the session knowledge tool instead.');
    guard();
    return {guard, release};
  } catch (error) {release();throw error;}
}
