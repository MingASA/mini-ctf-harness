import {parseArgs} from 'node:util';
import {loadCatalog} from './catalog.mjs';
import {askReference} from './reader.mjs';

try {
  const {positionals: [op = 'browse', ...args], values} = parseArgs({allowPositionals: true,
    options: {tag: {type: 'string'}, scope: {type: 'string'}, limit: {type: 'string'}, offset: {type: 'string'}, model: {type: 'string'}}});
  const lookup = loadCatalog();
  if (op === 'ask') {
    if (!values.model || Object.keys(values).length !== 1 || args.length !== 1)
      throw Error('Usage: knowledge ask --model MODEL "question"');
    console.log(await askReference({model: values.model, question: args[0], lookup,
      baseUrl: process.env.MINI_CTF_KNOWLEDGE_MODEL_URL || 'http://127.0.0.1:8080/v1'}));
  } else {
    const request = {op, ...values};
    if (op === 'search') request.query = args[0];
    if (op === 'get') request.id = args[0];
    if (args.length !== (op === 'browse' ? 0 : 1)) throw Error('Usage: knowledge browse | search "query" | get ID');
    for (const key of ['limit', 'offset']) if (key in request) request[key] = Number(request[key]);
    console.log(JSON.stringify(lookup(request), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
