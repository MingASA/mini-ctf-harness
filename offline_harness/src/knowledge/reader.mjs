import {tokenize} from '../rag/text.mjs';
import {validateServiceUrl} from '../service-endpoint.mjs';

export const knowledgeTool = {
  type: 'function',
  function: {
    name: 'knowledge',
    description: 'Search local reference summaries. Browse a scope to discover topics; get one ID for details and sources.',
    parameters: {
      type: 'object', properties: {
        op: {type: 'string', enum: ['browse', 'search', 'get']},
        query: {type: 'string', description: 'Required for search.'},
        scope: {type: 'string', description: 'Optional catalog scope for browse/search.'},
        tag: {type: 'string', description: 'Optional filter for browse/search: web, reverse, pwn, crypto, misc.'},
        id: {type: 'string', description: 'Required for get. Use a returned ID.'},
        offset: {type: 'integer', minimum: 0, description: 'Browse page offset.'},
        limit: {type: 'integer', minimum: 1, maximum: 5}
      }, required: ['op'], additionalProperties: false
    }
  }
};

// A reference-only conversation. It shares neither tools nor state with task sessions.
export async function askReference({baseUrl, model, question, lookup, textOnly = false}) {
  const base = validateServiceUrl(baseUrl);
  if (!['127.0.0.1', '[::1]'].includes(base.hostname)) throw Error('Use a numeric loopback model endpoint');
  if (!model?.trim() || !question?.trim()) throw Error('Expected model and question');
  const url = new URL(base.href.replace(/\/$/, '') + '/chat/completions');
  const messages = [
    {role: 'system', content: 'Answer reference questions using knowledge. Search first, and get one card only when the summary is insufficient. Cite the card ID. If the catalog lacks an answer, say so.'},
    {role: 'user', content: question}
  ];
  let reference;
  if (textOnly) {
    const {results} = lookup({op: 'search', query: question, limit: 1});
    if (!results.length) return '知识库没有匹配项。';
    const {id, title, summary, applies, detail, boundary} = lookup({op: 'get', id: results[0].id});
    const terms = new Set(tokenize(question));
    const sentences = (detail + '。' + boundary).split(/[。！？]/u).filter(Boolean);
    const ranked = sentences.map(text => ({text, score: [...new Set(tokenize(text))].filter(t => terms.has(t)).length}))
      .sort((a, b) => b.score - a.score);
    const excerpt = ranked[0]?.score ? ranked[0].text : '';
    reference = [summary, excerpt].filter(Boolean).join(' ');
    messages[0].content = '你是只读资料查询助手。依据所给原文回答最后的问题；若原文不足，说明缺少什么。';
    messages[1].content = ['卡片 ' + id, title, applies, reference, '', '问题：' + question].join('\n');
    reference = '[' + id + '] ' + reference;
  }
  for (let turn = 0; turn < 8; turn++) {
    const response = await fetch(url, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model, messages, ...(textOnly ? {} : {tools: [knowledgeTool]}), stream: false})});
    if (!response.ok) throw Error('Local model returned HTTP ' + response.status);
    const message = (await response.json()).choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw Error('Invalid local model reply');
    if (!message.tool_calls?.length) {
      if (!message.content?.trim()) throw Error('Local model returned an empty answer');
      return textOnly ? '检索原文 ' + reference + '\n\n模型回答 ' + message.content.trim() : message.content;
    }
    if (textOnly) throw Error('Unexpected tool call in text-only mode');
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 3) throw Error('Invalid tool call batch');
    messages.push(message);
    for (const call of message.tool_calls) {
      if (call.function?.name !== 'knowledge' || !call.id) throw Error('Unknown model tool call');
      let result;
      try { result = lookup(JSON.parse(call.function.arguments)); }
      catch (error) { result = {error: error.message}; }
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result)});
    }
  }
  throw Error('Reference reader reached its turn limit');
}
