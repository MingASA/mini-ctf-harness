import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {loadCatalog} from '../src/knowledge/catalog.mjs';
import {knowledgeTool, askReference} from '../src/knowledge/reader.mjs';
import {metrics} from '../src/rag/evaluate.mjs';

const lookup = loadCatalog();
const fixtures = {
  'languages/php/assert-string': ['zend.assertions', 'PHP 7.2 字符串断言还会求值吗', 'string assertion'],
  'languages/php/number-string-comparison': ['==', 'PHP 8 非数字字符串和 0 比较', 'non-numeric string'],
  'languages/php/numeric-trailing-space': ['is_numeric', '数字后面有空格', 'trailing whitespace'],
  'formats/elf/nobits': ['SHT_NOBITS', '节的内存大小与文件大小', 'sh_offset'],
  'formats/png/chunk-length': ['chunk length', 'PNG 数据块的长度包含类型吗', 'IEND 几个字节'],
  'formats/png/crc-coverage': ['CRC32', '校验和包括块类型吗', 'PNG checksum']
};

test('symbol and descriptive queries rank known cards; negatives abstain', t => {
  let recall = 0, mrr = 0, count = 0;
  for (const [id, queries] of Object.entries(fixtures)) {
    for (const query of queries) {
      const {results} = lookup({op: 'search', query});
      const ranking = results.map(row => row.id);
      const metric = metrics(ranking, {[id]: 1}, 3);
      if (query === queries[0]) assert.equal(ranking[0], id, query);
      assert.equal(metric.recall, 1, query);
      recall += metric.recall; mrr += metric.mrr; count++;
      for (const row of results) assert.deepEqual(Object.keys(row).sort(), ['applies', 'id', 'summary', 'title']);
    }
  }
  t.diagnostic(JSON.stringify({queries: count, recallAt3: recall/count, mrrAt3: mrr/count}));
  for (const query of ['QUIC', 'PHP fibers', 'PNG zTXt', '']) {
    if (query === '') assert.throws(() => lookup({op: 'search', query}));
    else assert.deepEqual(lookup({op: 'search', query}), {results: []}, query);
  }
  assert.deepEqual(lookup({op: 'search', query: 'assert', scope: 'formats'}), {results: []});
  assert.deepEqual(lookup({op: 'search', query: 'SHT_NOBITS', tag: 'web'}), {results: []});
  assert.equal(lookup({op: 'search', query: 'SHT_NOBITS', tag: 'reverse'}).results[0].id, 'formats/elf/nobits');
});

test('browse is paginated; details require a single registered id', () => {
  const page = lookup({op: 'browse', limit: 1});
  assert.deepEqual(page, {entries: [{scope: 'formats', count: 3}], nextOffset: 1});
  assert.deepEqual(lookup({op: 'browse', limit: 1, offset: page.nextOffset}).entries, [{scope: 'languages', count: 3}]);
  const rows = lookup({op: 'browse', scope: 'languages/php'}).entries;
  assert.equal(rows.length, 3);
  for (const {id} of rows) {
    const card = lookup({op: 'get', id});
    assert.ok(card.detail && card.boundary && card.sources.reference && card.sources.context);
    assert.ok(!JSON.stringify(knowledgeTool).includes(id));
  }
  for (const args of [{op: 'get', id: '../README.md'}, {op: 'get', id: '*'}, {op: 'get', id: rows.map(r => r.id)},
    {op: 'browse', scope: 'unknown'}, {op: 'browse', offset: -1}, {op: 'search', query: 'a', limit: 6},
    {op: 'get', id: rows[0].id, includeAll: true}]) assert.throws(() => lookup(args));
});

test('repository launcher resolves the catalog outside the working directory', () => {
  const cmd = fileURLToPath(new URL('../../mini-ctf', import.meta.url));
  const result = spawnSync(cmd, ['knowledge', 'search', 'CRC32', '--limit', '1'], {cwd: '/', encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].id, 'formats/png/crc-coverage');
});

test('loopback model protocol exposes only the lookup tool, and expands one card on demand', async t => {
  const seen = [];
  const id = 'formats/png/crc-coverage';
  const queries = [{op: 'search', query: 'CRC32', limit: 1}, {op: 'get', id}];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    seen.push(JSON.parse(raw));
    const n = seen.length - 1;
    const message = n < queries.length ? {role: 'assistant', content: null, tool_calls: [{
      id: 'lookup-' + n, type: 'function', function: {name: 'knowledge', arguments: JSON.stringify(queries[n])}
    }]} : {role: 'assistant', content: id};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({choices: [{message}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const answer = await askReference({baseUrl, model: 'protocol-fixture', question: 'PNG 校验范围', lookup});
  assert.equal(answer, id);
  assert.deepEqual(seen[0].tools, [knowledgeTool]);
  assert.ok(!JSON.stringify(seen[0]).includes(id));
  const summary = seen[1].messages.at(-1), detail = seen[2].messages.at(-1);
  assert.equal(summary.tool_call_id, 'lookup-0');
  assert.deepEqual(Object.keys(JSON.parse(summary.content).results[0]).sort(), ['applies','id','summary','title']);
  assert.equal(JSON.parse(detail.content).id, id);
  assert.ok(JSON.parse(detail.content).sources.reference);
  t.diagnostic(JSON.stringify({toolSchemaBytes: Buffer.byteLength(JSON.stringify(knowledgeTool)),
    searchResultBytes: Buffer.byteLength(summary.content), cardBytes: Buffer.byteLength(detail.content)}));
});
