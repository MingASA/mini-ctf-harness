import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const TOKENIZER_VERSION = 'unicode-words-cjk-bigrams-v1';
const STOP = new Set('a an the and or of to for in on is are was were be been with from by as at it its this that how what when which do does can i we my'.split(' '));

export function tokenize(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const latin = normalized.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = latin.filter(t => !STOP.has(t));
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || []) {
    const chars = [...run];
    if (chars.length === 1) tokens.push(chars[0]);
    for (let i=0; i<chars.length-1; i++) tokens.push(chars[i]+chars[i+1]);
  }
  return tokens;
}

export function chunkBytes(raw, {maxChunkBytes=2048, overlapBytes=128}={}) {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 64 || maxChunkBytes > 32768 ||
      !Number.isInteger(overlapBytes) || overlapBytes < 0 || overlapBytes >= maxChunkBytes/2) throw Error('Invalid chunk bounds');
  new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(raw);
  const chunks = [];
  for (let start=0; start<raw.length;) {
    let end = Math.min(start+maxChunkBytes, raw.length);
    while (end < raw.length && (raw[end] & 0xc0) === 0x80) end--;
    if (end < raw.length) {
      const boundary = raw.lastIndexOf('\n\n', end-2);
      if (boundary >= start+maxChunkBytes/2) end = boundary+2;
    }
    const text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(raw.subarray(start,end));
    if (text.trim()) chunks.push({startByte:start,endByte:end,text,sha256:digest(raw.subarray(start,end))});
    if (end === raw.length) break;
    let next = end-overlapBytes;
    while (next < end && (raw[next] & 0xc0) === 0x80) next++;
    start = next > start ? next : end;
  }
  return chunks;
}

export function frequencies(tokens) {
  const tf = Object.create(null);
  for (const token of tokens) tf[token] = (tf[token] || 0)+1;
  return tf;
}

export function cosine(a,b) {
  if (!Array.isArray(a) || a.length !== b.length || !a.length) throw Error('Vector dimension mismatch');
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++) { dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i]; }
  return aa && bb ? dot/Math.sqrt(aa*bb) : 0;
}
