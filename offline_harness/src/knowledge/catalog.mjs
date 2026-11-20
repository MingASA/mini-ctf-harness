import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bm25} from '../rag/search.mjs';
import {frequencies} from '../rag/text.mjs';
import {fold, normalizeQuery, literals, terms, anchors, hasAnchor, supportedSpans} from './retrieval.mjs';

const root = fileURLToPath(new URL('../../../knowledge/', import.meta.url));
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fields = ['title', 'summary', 'applies', 'detail', 'boundary', 'relevance'];
const validString = value => typeof value === 'string' && !!value.trim();
function versionTerms(text) {
  return (text.match(/\b\d+\.\d+(?:\.\d+)?\b/g) || []).map(v => 'version' + v.replaceAll('.', 'p'));
}
function readCards(dir, parts = []) {
  const cards = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && slug.test(entry.name)) {
      cards.push(...readCards(file, [...parts, entry.name]));
    } else if (entry.name.endsWith('.json')) {
      const name = entry.name.slice(0, -5);
      if (!entry.isFile() || !slug.test(name) || !parts.length)
        throw Error('Invalid knowledge file: ' + file);
      const card = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!card || !fields.every(key => validString(card[key])) ||
          !Array.isArray(card.aliases) || !card.aliases.length ||
          !card.aliases.every(validString) ||
          (card.tags !== undefined && (!Array.isArray(card.tags) || !card.tags.every(t => typeof t === 'string' && slug.test(t)))) ||
          !['reference', 'context'].every(k => validString(card.sources?.[k]) && new URL(card.sources[k]).protocol === 'https:'))
        throw Error('Invalid knowledge card: ' + file);
      cards.push({...card, id: [...parts, name].join('/'), scope: parts.join('/')});
    }
  }
  return cards;
}

const operations = {
  browse: ['scope', 'offset', 'limit', 'tag'],
  search: ['scope', 'query', 'limit', 'offset', 'tag'],
  get: ['id']
};
export function loadCatalog(dir = root) {
  const cards = readCards(dir).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const byId = new Map(cards.map(c => [c.id, c]));
  const scopes = new Set(['']);
  for (const {scope} of cards) {
    const parts = scope.split('/');
    for (let i = 1; i <= parts.length; i++) scopes.add(parts.slice(0, i).join('/'));
  }
  const df = Object.create(null);
  const chunks = cards.map(c => {
    const metadata = [c.scope.replaceAll('/', ' '), c.title, ...c.aliases, c.summary, c.applies, c.detail, c.boundary, c.relevance].join(' ');
    const tokens = [...terms(metadata), ...versionTerms(metadata)];
    const tf = frequencies(tokens);
    for (const term of Object.keys(tf)) df[term] = (df[term] || 0) + 1;
    return {id: c.id, documentId: c.id, tf, length: tokens.length, metadata, headings:new Set(terms([c.title,...c.aliases].join(' ')))};
  });
  const index = {chunks, statistics: {count: chunks.length, df,
    averageLength: chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1)}};
  const inScope = (c, scope) => !scope || c.scope === scope || c.scope.startsWith(scope + '/');
  const scopeWords = new Set([...scopes].flatMap(s => s.split('/')));

  function search(query, scope, limit, offset, tag) {
    if (!validString(query)) throw Error('Search requires query, for example {"op":"search","query":"PNG CRC32"}.');
    const q = normalizeQuery(query);
    const symbols = new Set(literals(q));
    const words = terms(q);
    const required = anchors(q);
    const coverage = required.map(anchor => ({anchor, scopes:new Set(cards.filter((c,i) => hasAnchor(chunks[i].metadata,anchor)).map(c=>c.scope))}));
    const topic = words.filter(t => !scopeWords.has(t) && !/^\d+$/.test(t));
    const qualifiers = words.filter(t => scopeWords.has(t));
    const versions = versionTerms(q);
    const rows = new Map(bm25(index, [...words, ...versions].join(' ')).map(r => [r.documentId, r.score]));
    const hits = [];
    for (const [i, c] of cards.entries()) {
      if (!inScope(c, scope) || (tag && !c.tags?.includes(tag))) continue;
      if (coverage.some(({anchor,scopes}) => !hasAnchor(chunks[i].metadata, anchor) && !scopes.has(c.scope))) continue;
      const exact = c.aliases.some(alias => {
        const a = fold(alias);
        if (/^[\x00-\x7f]+$/.test(a) && !a.includes(' ')) return symbols.has(a) || (a.startsWith('.') && q.trim() === a);
        return q.trim() === a;
      });
      const subject = qualifiers.some(t => hasAnchor(chunks[i].metadata, t));
      const matched = [...new Set(topic)].filter(t => Object.hasOwn(chunks[i].tf, t));
      const spans=supportedSpans(q,matched);
      const specific=matched.some(t=>(df[t]||0)<=2&&chunks[i].headings.has(t))&&(spans.some(s=>s.length>=3)||spans.join('').length>=q.replace(/\s/g,'').length/2);
      const numeric=words.some(t=>/^\d+$/.test(t)&&Object.hasOwn(chunks[i].tf,t));
      const modular=c.scope==='math/modular'&&/(?:模\s*\d|乘法|除以|余数|逆元)/u.test(q)&&spans.length>=2;
      const covered=spans.length>=2&&spans.join('').length>=q.replace(/\s/g,'').length/2;
      if(!exact&&!required.length&&!specific&&!numeric&&!modular&&!covered&&spans.length<3&&!(spans.length===1&&q.trim()===spans[0]))continue;
      const direct = required.filter(t=>hasAnchor(chunks[i].metadata,t)).length;
      if (required.length && !direct && matched.length < 2) continue;
      if (!exact && !required.length && !(subject && topic.length === 0) &&
          (matched.length < 2 && !matched.some(t => (df[t] || 0) <= 2))) continue;
      hits.push({card: c, exact, subject, direct, score: rows.get(c.id) || 0});
    }
    hits.sort((a, b) => Number(b.exact) - Number(a.exact) || (b.score+2*b.direct)-(a.score+2*a.direct) || Number(b.subject) - Number(a.subject) || a.card.id.localeCompare(b.card.id,'en'));
    return {results: hits.slice(offset, offset + limit).map(({card: {id, title, summary, applies}}) => ({id, title, summary, applies})),
      total: hits.length, nextOffset: offset + limit < hits.length ? offset + limit : null};
  }

  return function queryKnowledge(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.op !== 'string' || !Object.hasOwn(operations, args.op) ||
        Object.keys(args).some(k => k !== 'op' && !operations[args.op].includes(k))) throw Error('Invalid knowledge operation or fields. Use {"op":"search","query":"question"}, {"op":"get","id":"returned-id"}, or {"op":"browse"}. Search/browse accept scope, tag, offset and limit; omit unused fields.');
    if (args.op === 'get') {
      const c = byId.get(args.id);
      if (!c) throw Error('Unknown knowledge card ID. Copy one id from search results or browse entries, then call {"op":"get","id":"that-id"}.');
      const {id, title, summary, applies, detail, boundary, relevance, sources} = c;
      return {id, title, summary, applies, detail, boundary, relevance, sources, citation:`[${id}](${sources.reference})`};
    }
    const {tag} = args;
    if (tag !== undefined && (typeof tag !== 'string' || !slug.test(tag))) throw Error('Invalid topic tag');
    const {scope = '', limit = args.op === 'search' ? 3 : 5, offset = 0} = args;
    if (!scopes.has(scope)) throw Error('Unknown knowledge scope. Retry without scope to search all cards, or use browse to discover valid scopes. Use tag for web/reverse/pwn/crypto/misc.');
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('limit must be a positive integer');
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset must be a nonnegative integer; copy nextOffset from the previous page.');
    if (args.op === 'search') return search(args.query, scope, limit, offset, args.tag);
    const visible = tag ? cards.filter(c => c.tags?.includes(tag)) : cards;
    const parent = id => id.split('/').slice(0, -1).join('/');
    const entries = [...scopes].filter(s => s && parent(s) === scope).sort()
      .map(s => ({scope: s, count: visible.filter(c => inScope(c, s)).length})).filter(entry => entry.count > 0);
    entries.push(...visible.filter(c => c.scope === scope).map(({id, title}) => ({id, title})));
    return {entries: entries.slice(offset, offset + limit), nextOffset: offset + limit < entries.length ? offset + limit : null};
  };
}
