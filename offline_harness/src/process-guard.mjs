import fs from 'node:fs';

// Kept dependency-free so offline lookup does not need the inference SDK.
export const DEFAULT_GUARD = process.env.MINI_CTF_PROCESS_GUARD;
export function assertExperimentIdle(processFile = DEFAULT_GUARD) {
  if (!processFile || !fs.existsSync(processFile)) return;
  const p = JSON.parse(fs.readFileSync(processFile, 'utf8').replace(/^\uFEFF/, ''));
  if (!Number.isInteger(p.pid) || p.pid < 1) throw Error('Invalid active experiment process receipt');
  const proc = `/proc/${p.pid}/stat`;
  if (fs.existsSync(proc) && fs.readFileSync(proc, 'utf8').split(') ').at(-1)[0] !== 'Z')
    throw Error(`Current experiment is running (PID ${p.pid}); no model or metadata request permitted`);
}
