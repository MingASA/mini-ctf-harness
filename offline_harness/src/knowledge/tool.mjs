import {loadCatalog} from './catalog.mjs';

export const knowledgeTool = {
  type: 'function',
  function: {
    name: 'knowledge',
    description: 'Consult offline references when a specific knowledge gap blocks the next step, observed behavior contradicts your understanding, or attempts stall and a factual assumption needs checking. To seek help, start with {"op":"search","query":"topic"}. Wait for results before using {"op":"get","id":"returned-id"} for one full card. Browse discovers scopes. Omit fields not used by the chosen operation.',
    parameters: {
      type: 'object', properties: {
        op: {type: 'string', enum: ['browse', 'search', 'get']},
        query: {type: 'string', description: 'Required for search.'},
        scope: {type: 'string', description: 'Optional exact scope returned by browse (for example formats/png). Omit when unknown. CTF categories belong in tag.'},
        tag: {type: 'string', description: 'Optional filter for browse/search: web, reverse, pwn, crypto, misc.'},
        id: {type: 'string', description: 'Required for get. Copy one ID from search/browse.'},
        offset: {type: 'integer', minimum: 0, description: 'Browse page offset.'},
        limit: {type: 'integer', minimum: 1, maximum: 5}
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
  'Use op=browse when you need to discover available topics; use tag for CTF categories and nextOffset to page. If a scope is invalid, retry without scope.',
  'After reading, state which assumption the entry resolves and test the resulting hypothesis against the task. Reuse already retrieved facts while they remain applicable.',
  'If nothing relevant is found, refine the query around a concrete uncertainty or return to task evidence. This local corpus works offline.'
].join(' ');
