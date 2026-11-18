import {toolText} from './tool-display.mjs';

export const safeText=value=>String(value??'').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'�');

const sectionsOf=message=>typeof message.content==='string'
 ?[{type:'text',text:message.content}]:message.content??[];
const displayBlock=block=>block.type==='text'?block.text:'[附件]';
const colors={thinking:36,reply:32,tool:33,error:31};

export function toolResultText(message){
 return sectionsOf(message).map(block=>block.type==='text'
  ?toolText(message.toolName,block.text):displayBlock(block)).join('\n');
}

function toolPreview(text,index){
 const preview=text.split('\n',7).slice(0,6).join('\n').slice(0,400);
 if(preview.length===text.length)return text;
 return preview.trimEnd()+`\n… 已折叠 · /tool ${index} 查看`;
}

function appendMessage(sections,message,live,toolIndex){
 const add=(label,body,style)=>sections.push({label:live?label+' · 生成中':label,body,style});
 if(message.role==='toolResult'){
  add(`工具结果 ${toolIndex} · ${message.toolName??'工具'}`,toolPreview(toolResultText(message),toolIndex),'tool');
 }else if(message.role==='assistant'){
  const blocks=sectionsOf(message);
  const toolStep=blocks.some(block=>block.type==='toolCall');
  for(const block of blocks){
   if(block.type==='thinking'&&block.thinking)add('模型思考',block.thinking,'thinking');
   else if(block.type==='text'&&block.text)add(toolStep?'模型说明':'正式回复',block.text,'reply');
   else if(block.type==='toolCall')add('工具调用',block.name+' '+JSON.stringify(block.arguments),'tool');
   else if(block.type==='image')add('附件',displayBlock(block));
  }
 }else{
  const role={user:'你',system:'系统'}[message.role]??message.role;
  const label=message.harnessInboxId?role+' · '+message.harnessInboxId:role;
  add(label,sectionsOf(message).map(displayBlock).join('\n'));
 }
 if(message.harnessInterruptedEvidence)add('手动中断，工具草稿未执行','/read '+message.harnessInterruptedEvidence,'error');
 if(message.errorMessage)add('中断',message.errorMessage,'error');
}

export function transcriptText(messages,live,{useColor=true}={}){
 const first=Math.max(0,messages.length-100);
 let toolIndex=messages.slice(0,first).filter(message=>message.role==='toolResult').length;
 const sections=[];
 for(const message of messages.slice(first)){
  if(message.role==='toolResult')toolIndex++;
  appendMessage(sections,message,false,toolIndex);
 }
 if(live)appendMessage(sections,live,true,toolIndex);

 // Cap plain text before adding ANSI sequences, preserving the label of the first visible block.
 const output=[];
 let available=160000;
 for(const {label,body,style} of sections.reverse()){
  const heading=`[${safeText(label)}]`;
  const bodyLimit=available-heading.length-3;
  if(bodyLimit<=0)break;
  const value=safeText(body);
  const plain=value?heading+'\n'+value.slice(-bodyLimit):heading;
  available-=plain.length+2;
  output.push(useColor&&colors[style]?`\x1b[${colors[style]}m${plain}\x1b[0m`:plain);
 }
 return output.reverse().join('\n\n')||'题目已入队，等待推理。';
}
