import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bm25} from '../rag/search.mjs';
import {frequencies, tokenize} from '../rag/text.mjs';

const root = fileURLToPath(new URL('../../../knowledge/', import.meta.url));
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fields = {title: 100, summary: 180, applies: 140, detail: 700, boundary: 500, relevance: 300};
const validString = (value, cap) => typeof value === 'string' && value.trim() && value.length <= cap;
const fold = text => text.normalize('NFKC').toLowerCase();

// Keep literal operators and identifiers intact alongside BM25's word and CJK tokens.
function literals(text) {
  return fold(text).match(/[a-z0-9_]+(?:\.[a-z0-9_]+)*(?:\(\))?|[=<>!]+/g) || [];
}
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
      if (!entry.isFile() || !slug.test(name) || !parts.length || fs.statSync(file).size > 8192)
        throw Error('Invalid knowledge file: ' + file);
      const card = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!card || !Object.entries(fields).every(([key, cap]) => validString(card[key], cap)) ||
          !Array.isArray(card.aliases) || !card.aliases.length || card.aliases.length > 20 ||
          !card.aliases.every(a => validString(a, 80)) ||
          (card.tags !== undefined && (!Array.isArray(card.tags) || !card.tags.every(t => typeof t === 'string' && slug.test(t)))) ||
          !['reference', 'context'].every(k => validString(card.sources?.[k], 500) && new URL(card.sources[k]).protocol === 'https:'))
        throw Error('Invalid knowledge card: ' + file);
      cards.push({...card, id: [...parts, name].join('/'), scope: parts.join('/')});
    }
  }
  return cards;
}

const operations = {
  browse: ['scope', 'offset', 'limit'],
  search: ['scope', 'query', 'limit', 'tag'],
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
    const metadata = [c.title, ...c.aliases, c.summary, c.applies, c.detail, c.boundary].join(' ');
    const tokens = [...tokenize(metadata), ...versionTerms(metadata)];
    const tf = frequencies(tokens);
    for (const term of Object.keys(tf)) df[term] = (df[term] || 0) + 1;
    return {id: c.id, documentId: c.id, tf, length: tokens.length};
  });
  const index = {chunks, statistics: {count: chunks.length, df,
    averageLength: chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1)}};
  const inScope = (c, scope) => !scope || c.scope === scope || c.scope.startsWith(scope + '/');
  const scopeWords = new Set([...scopes].flatMap(s => s.split('/')));

  function search(query, scope, limit, tag) {
    if (tag !== undefined && (typeof tag !== 'string' || !slug.test(tag))) throw Error('Invalid topic tag');
    if (!validString(query, 512)) throw Error('Expected a nonempty query of at most 512 characters');
    const q = fold(query);
    const symbols = new Set(literals(q));
    const words = tokenize(q);
    const topic = words.filter(t => !scopeWords.has(t) && !/^\d+$/.test(t));
    const qualifiers = words.filter(t => scopeWords.has(t));
    const versions = versionTerms(q);
    const rows = new Map(bm25(index, [q, ...versions].join(' ')).map(r => [r.documentId, r.score]));
    const hits = [];
    for (const [i, c] of cards.entries()) {
      if (!inScope(c, scope) || (tag && !c.tags?.includes(tag))) continue;
      const exact = c.aliases.some(alias => {
        const a = fold(alias);
        if (/^[\x00-\x7f]+$/.test(a) && !a.includes(' ')) return symbols.has(a) || (a.startsWith('.') && q.trim() === a);
        return q.trim() === a;
      });
      const subject = qualifiers.some(t => c.scope.split('/').includes(t));
      if (!exact && !topic.some(t => Object.hasOwn(chunks[i].tf, t)) && !(subject && topic.length === 0)) continue;
      hits.push({card: c, exact, subject, score: rows.get(c.id) || 0});
    }
    hits.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.subject) - Number(a.subject) || b.score - a.score);
    return {results: hits.slice(0, limit).map(({card: {id, title, summary, applies}}) => ({id, title, summary, applies}))};
  }

  return function queryKnowledge(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.op !== 'string' || !Object.hasOwn(operations, args.op) ||
        Object.keys(args).some(k => k !== 'op' && !operations[args.op].includes(k))) throw Error('Invalid knowledge operation or fields');
    if (args.op === 'get') {
      const c = byId.get(args.id);
      if (!c) throw Error('Unknown knowledge card ID');
      const {id, title, summary, applies, detail, boundary, relevance, sources} = c;
      return {id, title, summary, applies, detail, boundary, relevance, sources};
    }
    const {scope = '', limit = args.op === 'search' ? 3 : 5, offset = 0} = args;
    if (!scopes.has(scope)) throw Error('Unknown knowledge scope');
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw Error('limit must be 1..5');
    if (args.op === 'search') return search(args.query, scope, limit, args.tag);
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid browse offset');
    const parent = id => id.split('/').slice(0, -1).join('/');
    const entries = [...scopes].filter(s => s && parent(s) === scope).sort()
      .map(s => ({scope: s, count: cards.filter(c => inScope(c, s)).length}));
    entries.push(...cards.filter(c => c.scope === scope).map(({id, title}) => ({id, title})));
    return {entries: entries.slice(offset, offset + limit), nextOffset: offset + limit < entries.length ? offset + limit : null};
  };
}
