import {tokenize} from '../rag/text.mjs';

// Conversational words cannot establish coverage of a technical topic. This
// vocabulary is independent of corpus IDs and evaluation queries.
const prose = new Set(('a an the and or of to for in on is are was were be been with from by as at it its this that how what when which do does can i we my '
  + 'why where who explain please help tell about using use used uses work works working support supports supported example examples '
  + 'get gets getting set return returns returned value values result results input output correct incorrect different difference '
  + 'need needs should would could must may might not no yes into between after before under over than then if else while '
  + 'read reading write writing mean means meaning happen happens happening given following find found have has had will '
  + 'all any some only also still always never already each every both same other more less first last next previous '
  + 'file files data string strings number numbers byte bytes bit bits length size offset order format field fields '
  + 'calculate calculated check checking decode decoding encode encoding convert conversion parse parsing interpreted measure '
  + 'contains include includes including exclude excludes consist consists handle handles preserve keeps keep '
  + 'become becomes cause causes change changes behavior behaviour counts count consume consumed copied copying seek buffer buffers code permit permits permitted allow allows allowed kb kib mb mib gb gib db').split(/\s+/));
const chineseProse = new Set('怎么 如何 为什么 什么 是否 能否 可以 不能 使用 工作 支持 配置 原理 问题 解释 说明 请问 一个 这个 那个 哪个 哪些 多少 需要 应该 如果 然后 得到 出现 发生 时候 情况 里面 这里 那里 还是 是什 么意 意思 为什 么会'.split(' '));
// Small bilingual retrieval glossary, not factual equivalences between APIs.
const concepts = [
  ['overlap','重叠'], ['negative','负数','负值','负'], ['positive','正数','正值'],
  ['height','高度'], ['width','宽度'], ['point','码点'], ['unit','单元'],
  ['checksum','校验和'], ['padding','填充'], ['alignment','对齐'],
  ['overflow','溢出'], ['signed','有符号'], ['unsigned','无符号'],
  ['truncate','截断'], ['pointer','指针'], ['integer','整数'], ['float','浮点'],
  ['little-endian','小端'], ['big-endian','大端'], ['newline','换行'],
  ['member','成员'], ['name','名称'],
];
export const fold = text => text.normalize('NFKC').toLowerCase();
export function normalizeQuery(text) {
  return fold(text).replace(/\bjs\b/g, 'javascript').replace(/\bgz\b/g, 'gzip').replace(/\b(php|python)(?=\d)/g, '$1 ');
}
// A compound identifier is atomic: "safe-linking" must not match alias "safe".
export function literals(text) {
  return fold(text).match(/[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*(?:\(\))?|[=<>!~]+/g) || [];
}
export function terms(text) {
  const tokens = tokenize(text).filter(t => !prose.has(t) && !chineseProse.has(t) && !/[的了]/u.test(t));
  for (let i=0;i<concepts.length;i++) if (concepts[i].some(v => contains(text, v))) tokens.push('concept'+i);
  return tokens;
}
export function anchors(query) {
  return [...new Set(literals(query).filter(t => /[a-z]/.test(t) && t.length > 1 && !prose.has(t) && !/^(?:0x)?[a-f0-9]{2,}$/.test(t)))];
}
export function supportedSpans(query, matched) {
  const ranges=[];
  for (const term of matched) {
    if (!/[\p{Script=Han}]/u.test(term)) continue;
    for(let start=query.indexOf(term);start!==-1;start=query.indexOf(term,start+1))ranges.push([start,start+term.length]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  const joined=[];
  for(const range of ranges){const last=joined.at(-1);if(last&&range[0]<last[1])last[1]=Math.max(last[1],range[1]);else joined.push([...range]);}
  return [...new Set(joined.map(([start,end])=>query.slice(start,end)))];
}
const equivalents = [
  ['arm64', 'aarch64'], ['linux', 'unix'], ['debug', 'debugging', '调试'],
  ['wav', 'wave', 'pcm'], ['java', 'jvm'], ['switch', 'tableswitch'],
  ['unicode', 'utf16', 'utf8'], ['ip', 'pc', 'rip', '指令地址'],
];
const canonical = text => text.replace(/[._()-]/g, '');
function forms(word) {
  const variants = [canonical(word)];
  if (/^[a-z]+s$/.test(word)) variants.push(word.slice(0,-1));
  if (/^[a-z]+ing$/.test(word)) {
    const stem=word.slice(0,-3);variants.push(stem,stem+'e',stem.replace(/([a-z])\1$/, '$1'));
  }
  return variants;
}
function contains(text, value) {
  if (/[^a-z0-9-]/.test(value)) return fold(text).includes(value);
  return literals(text).some(t => forms(t).includes(canonical(value)));
}
export function hasAnchor(text, anchor) {
  const key = canonical(anchor), variants = new Set(forms(anchor));
  for (const group of equivalents) if (group.includes(key)) for (const value of group) variants.add(value);
  for (const group of concepts) if (group.some(v => variants.has(v))) for (const value of group) variants.add(value);
  const tokens = literals(text).flatMap(t => [t, ...t.split('_')]).map(canonical);
  return [...variants].some(v => /[^a-z0-9]/.test(v) ? fold(text).includes(v) : tokens.some(t => t === v || t === v + 'ed' || t === v + 's'));
}
