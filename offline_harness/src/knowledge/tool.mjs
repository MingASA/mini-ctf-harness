import {loadCatalog} from './catalog.mjs';

export const knowledgeTool = {
  type: 'function',
  function: {
    name: 'knowledge',
    description: 'Look up offline reference facts. Start with {"op":"search","query":"specific question"}; read the summaries, then {"op":"get","id":"ID from results"} for the full explanation, conditions and sources. To see more results, repeat the same search with offset=nextOffset; null means the end. {"op":"browse"} lists topics. Empty results mean no covered match; try a simpler factual question or browse. Omit unused fields.',
    parameters: {
      type: 'object', properties: {
        op: {type: 'string', enum: ['browse', 'search', 'get']},
        query: {type: 'string', minLength: 1, description: 'Required for search. Use a factual question with relevant format, identifier or runtime version.'},
        scope: {type: 'string', description: 'Optional exact scope returned by browse (for example formats/png). Omit when unknown. CTF categories belong in tag.'},
        tag: {type: 'string', description: 'Optional filter for browse/search: web, reverse, pwn, crypto, misc.'},
        id: {type: 'string', minLength: 1, description: 'Required for get. Copy one ID from search/browse.'},
        offset: {type: 'integer', minimum: 0, description: 'Search/browse: copy nextOffset from the previous page, keeping query and filters unchanged. Default 0.'},
        limit: {type: 'integer', minimum: 1, description: 'Results per page. Default 3 for search, 5 for browse; increase when useful.'}
      }, required: ['op'], additionalProperties: false
    }
  }
};

// The corpus is immutable during a running process. Restart after updating cards.
let catalog;
export function queryKnowledge(args) {
  catalog ??= loadCatalog();
  return catalog(args);
}

export const KNOWLEDGE_PROMPT = [
  'First use your existing knowledge and cheap observations of the task to make progress.',
  'Consult knowledge when you identify a specific missing or uncertain fact that blocks the next step, when observed behavior contradicts your understanding, or when repeated uninformative attempts expose a factual assumption that needs checking.',
  'A clear knowledge gap is enough to seek help immediately. When progress stalls, identify the unresolved fact before deciding whether knowledge can help.',
  'Keep routine task opening and familiar steps focused on the task. Reserve reference lookup for these knowledge gaps or an explicit request to consult the corpus.',
  'Form a targeted query from the relevant symbol, runtime version, format field or observed discrepancy. Start with op=search, omitting scope unless obtained from browse.',
  'Read the returned summaries and applicability first. Use op=get with one returned ID only when a needed detail, example or boundary is still missing.',
  'Use op=browse to discover topics and tag to filter CTF categories. Both search and browse support pagination: keep query/filters unchanged and set offset to nextOffset; null means the end. If a scope is invalid, retry without scope.',
  'After reading, state which assumption the entry resolves and test the resulting hypothesis against the task. Reuse already retrieved facts while they remain applicable.',
  'Search returns candidate references, not proof that the whole question is covered. Check the actual content and boundaries before applying it. When answering from a card, include its id or copy its citation field; do not omit version conditions.',
  'If nothing relevant is found, refine the query around a concrete uncertainty or return to task evidence. This local corpus works offline.'
].join(' ');
