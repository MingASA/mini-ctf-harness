// Explicit evaluation budgets below apply to this smoke test, not the product.
import fs from 'node:fs';
import {validateServiceUrl} from '../src/service-endpoint.mjs';
import {acquireReader} from '../src/knowledge/reader-lease.mjs';
import {knowledgeTool,queryKnowledge,KNOWLEDGE_PROMPT} from '../src/knowledge/tool.mjs';
const [baseUrl,configFile,outputFile]=process.argv.slice(2);
if(!baseUrl||!configFile||!outputFile)throw Error('Usage: node scripts/smoke-knowledge.mjs DEDICATED_URL COMPETITION_CONFIG OUTPUT_JSON');
const base=validateServiceUrl(baseUrl);
if(!['127.0.0.1','[::1]'].includes(base.hostname))throw Error('Use loopback');
const lease=acquireReader({base,configFile});
const controller=new AbortController(),cancel=()=>controller.abort();
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
const cases=[
 {name:'search-get',question:'核对 PNG CRC32 校验范围。先调用 knowledge 搜索，再 get 命中的完整卡片，最后引用卡片 ID，用中文回答哪些字节被校验。'},
 {name:'pagination',question:'使用 knowledge 搜索 PNG，每页 2 条。再根据 nextOffset 读取第二页，get 第二页任意一张卡片，最后简短说明它的适用边界。请使用工具，不要猜测 ID 或 offset。'},
 {name:'uncovered',question:'请用 knowledge 查询 PHP fibers 怎么使用。如果库中没有匹配资料，直接说明知识库未覆盖，不能用其他 PHP 主题替代。'}
];
const results=[];
try{
 for(const item of cases){
  const messages=[{role:'system',content:'You are a reference assistant. '+KNOWLEDGE_PROMPT},{role:'user',content:item.question}];
  const calls=[];let answer='',failure;
  for(let turn=0;turn<6;turn++){
   controller.signal.throwIfAborted();lease.guard();
   const response=await fetch(base.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),body:JSON.stringify({model:'knowledge-smoke-9b',messages,tools:[knowledgeTool],temperature:0.2,seed:42,max_tokens:384,chat_template_kwargs:{enable_thinking:false},stream:false})});
   if(!response.ok)throw Error('Model HTTP '+response.status);
   const data=await response.json(),message=data.choices?.[0]?.message;
   if(!message)throw Error('No assistant message');
   messages.push(message);
   if(!message.tool_calls?.length){answer=message.content??'';break;}
   for(const call of message.tool_calls){
    let args,result;
    try{if(call.function?.name!=='knowledge')throw Error('Unknown tool');args=JSON.parse(call.function.arguments);result=queryKnowledge(args);}
    catch(error){failure=error.message;result={error:error.message};}
    calls.push({args,result});
    messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
   }
  }
  const searches=calls.filter(c=>c.args?.op==='search'),gets=calls.filter(c=>c.args?.op==='get');
  let passed=!!answer&&!failure;
  if(item.name==='search-get')passed&&=searches.length>0&&gets.some(c=>c.args.id==='formats/png/crc-coverage')&&answer.includes('formats/png/crc-coverage');
  if(item.name==='pagination')passed&&=searches.length>=2&&searches[1].args.query===searches[0].args.query&&searches[1].args.offset===searches[0].result.nextOffset&&searches[1].args.limit===2&&gets.some(c=>searches[1].result.results.some(r=>r.id===c.args.id));
  if(item.name==='uncovered')passed&&=searches.length>0&&searches.every(c=>c.result.total===0)&&gets.length===0&&/未覆盖|没有|未收录|未找到|无匹配/.test(answer);
  results.push({...item,passed,calls,answer,failure});fs.writeFileSync(outputFile,JSON.stringify(results,null,2));
  console.log(JSON.stringify({name:item.name,passed,calls:calls.map(c=>c.args)}));
 }
 if(results.some(r=>!r.passed))process.exitCode=1;
}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);lease.release();}
