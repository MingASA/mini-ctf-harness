import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value);
export const observationSources = new Set(['tool:read','tool:wait_job','tool:run_command','tool:submit_flag','tool:view_image','tool:rag','tool:vision']);
export function atomic(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, json(value) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// A run contains agent-visible observations only; evaluator secrets live elsewhere.
export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(path.join(this.root, 'artifacts'), {recursive: true, mode: 0o700});
    this.file = path.join(this.root, 'journal.jsonl');
    this.events = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    let prev = '';
    for (let i = 0; i < this.events.length; i++) {
      const {digest, ...body} = this.events[i];
      if (body.seq !== i || body.prev !== prev || hash(json(body)) !== digest) throw Error('Journal integrity failure');
      prev = digest;
    }
  }
  append(type, data) {
    const body = {seq: this.events.length, prev: this.events.at(-1)?.digest || '', time: Date.now(), type, data:structuredClone(data)};
    const event = {...body, digest: hash(json(body))};
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, json(event) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.events.push(event);
    return event;
  }
  put(value, source) {
    const text = typeof value === 'string' ? value : json(value);
    const id = hash(text), file = path.join(this.root, 'artifacts', id);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
    this.append('artifact', {id, source, bytes: Buffer.byteLength(text)});
    return {id, bytes: Buffer.byteLength(text)};
  }
  read(id, offset = 0, limit = 4000) {
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 8000) throw Error('Invalid evidence range');
    if (!this.events.some(e => e.type === 'artifact' && e.data.id === id)) throw Error('Unknown evidence');
    const text = fs.readFileSync(path.join(this.root, 'artifacts', id), 'utf8');
    if (hash(text) !== id) throw Error('Evidence integrity failure');
    return {id, offset, total_chars: text.length, text: text.slice(offset, offset + limit), next_offset: Math.min(text.length, offset + limit)};
  }
  search(query, limit = 5) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
    if (!terms.length) return [];
    // Search original observations, not nested copies of earlier search results.
    const unique = new Map(this.events.filter(e => e.type === 'artifact' && observationSources.has(e.data.source)).map(e => [e.data.id, e.data]));
    return [...unique.values()].map(item => {
      const file = path.join(this.root, 'artifacts', item.id);
      const raw = fs.readFileSync(file, 'utf8');
      if (hash(raw) !== item.id) throw Error('Evidence integrity failure');
      const text = item.source === 'tool:view_image' ? json({...JSON.parse(raw),data:undefined}) : raw;
      const lower = text.toLowerCase();
      const score = terms.filter(t => lower.includes(t)).length;
      const offset = Math.max(0, lower.indexOf(terms.find(t => lower.includes(t)) || terms[0]) - 150);
      return {...item, score, offset, excerpt: text.slice(offset, offset + 700)};
    }).filter(x => x.score).sort((a,b) => b.score-a.score).slice(0, limit);
  }
  async execute(callId, name, args, operation) {
    const identity = hash(json({name, args}));
    const prior = this.events.find(e => e.type === 'tool_start' && e.data.callId === callId);
    if (prior) {
      if (prior.data.identity !== identity) throw Error('Tool call ID reused with different arguments');
      const done = this.events.find(e => e.type === 'tool_done' && e.data.callId === callId);
      if (!done) throw Error('Uncertain tool outcome: reconcile retained job/evidence before retry');
      return done.data.result;
    }
    this.append('tool_start', {callId, name, args, identity});
    const result = await operation();
    this.append('tool_done', {callId, result});
    return result;
  }
  pending() {
    return this.events.filter(e => e.type === 'tool_start' && !this.events.some(d => d.type === 'tool_done' && d.data.callId === e.data.callId));
  }
  snapshot(name, data) { atomic(path.join(this.root, name + '.json'), data); }
}
