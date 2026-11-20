import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {loadCatalog} = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../src/knowledge/catalog.mjs');
const lookup = loadCatalog();
const fixture = JSON.parse(fs.readFileSync(process.argv[3] || new URL('../test/fixtures/knowledge-heldout.json', import.meta.url)));
let top1 = 0, top3 = 0, reciprocal = 0;
const misses = [], falseMatches = [];
for (const [query, id] of fixture.positive) {
  const ids = lookup({op:'search', query}).results.map(r => r.id), rank = ids.indexOf(id);
  top1 += rank === 0; top3 += rank >= 0; reciprocal += rank < 0 ? 0 : 1 / (rank + 1);
  if (rank !== 0) misses.push({query, expected:id, ids});
}
for (const query of fixture.negative) {
  const ids = lookup({op:'search', query}).results.map(r => r.id);
  if (ids.length) falseMatches.push({query, ids});
}
console.log(JSON.stringify({positive:fixture.positive.length, top1, top3, mrr:reciprocal / fixture.positive.length,
  negative:fixture.negative.length, falseMatches: falseMatches.length, misses, falseMatchDetails:falseMatches}, null, 2));
