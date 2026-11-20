import {validateServiceUrl} from '../service-endpoint.mjs';
import {acquireReader} from './reader-lease.mjs';

import {knowledgeTool} from './tool.mjs';
export {knowledgeTool} from './tool.mjs';

// A reference-only conversation. It shares neither tools nor state with task sessions.
export async function askReference({baseUrl, model, question, lookup, textOnly = false, signal, configFile, guard}) {
  if (!baseUrl) throw Error('Set MINI_CTF_KNOWLEDGE_MODEL_URL to a separate model server. The competition backend is not used by standalone ask.');
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
    const {id, title, summary, applies, detail, boundary, sources} = lookup({op: 'get', id: results[0].id});
    reference = [summary, detail, '适用边界：' + boundary, '来源：' + sources.reference].join('\n');
    messages[0].content = '你是只读资料查询助手。依据所给原文回答最后的问题；若原文不足，说明缺少什么。';
    messages[1].content = ['卡片 ' + id, title, applies, reference, '', '问题：' + question].join('\n');
    reference = '[' + id + '] ' + reference;
  }
  signal?.throwIfAborted();
  const lease = acquireReader({base, configFile, guard});
  try {while (true) {
    signal?.throwIfAborted();lease.guard();
    const response = await fetch(url, {method: 'POST', redirect: 'error', signal,
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model, messages, ...(textOnly ? {} : {tools: [knowledgeTool]}), stream: false})});
    if (!response.ok) throw Error('Local model returned HTTP ' + response.status);
    const message = (await response.json()).choices?.[0]?.message;
    if (!message || message.role !== 'assistant') throw Error('Invalid local model reply');
    if (!message.tool_calls?.length) {
      if (!message.content?.trim()) throw Error('Local model returned an empty answer');
      return textOnly ? '检索原文 ' + reference + '\n\n模型回答 ' + message.content.trim() : message.content;
    }
    if (textOnly) throw Error('Unexpected tool call in text-only mode');
    if (!Array.isArray(message.tool_calls)) throw Error('Invalid tool call batch');
    messages.push(message);
    for (const call of message.tool_calls) {
      if (call.function?.name !== 'knowledge' || !call.id) throw Error('Unknown model tool call');
      let result;
      try { result = lookup(JSON.parse(call.function.arguments)); }
      catch (error) { result = {error: error.message}; }
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result)});
    }
  }} finally {lease.release();}
}
