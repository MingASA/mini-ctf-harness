import {loadCatalog} from './catalog.mjs';

export const knowledgeTool = {
  type: 'function',
  function: {
    name: 'knowledge',
    description: 'Search offline reference summaries. Start with {"op":"search","query":"topic"}. Wait for results before using {"op":"get","id":"returned-id"} for one full card. Browse discovers scopes. Omit fields not used by the chosen operation.',
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

export const KNOWLEDGE_PROMPT = 'Use knowledge to check specific language, runtime, ABI, format or mathematical facts when they affect the task. Start with op=search and a focused query, omitting scope unless you obtained it from browse. Results contain summaries and applicability. If a lookup reports an invalid scope, retry without scope. Use op=get with one returned ID only when more detail or a boundary is needed. Use op=browse to discover scopes or filter by tag, and nextOffset to page. This local corpus works offline. Treat its entries as reference facts and verify that their prerequisites match the task.';
