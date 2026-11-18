import {EFFORTS} from './generation-controls.mjs';

export const slashCommands=[
 ['start','启动题目调度'],
 ['queue','查看题目队列和状态'],
 ['review','选择候选答案并记录判题结果'],
 ['new','创建题目并导入本地附件'],
 ['view','选择要查看的题目'],
 ['priority','设置当前题的队列优先级'],
 ['switch','保存进度并切换推理题目'],
 ['pause','暂停当前题的推理'],
 ['resume','恢复当前题或指定题目'],
 ['offloadKV','保存驻留 KV 到内存，或配置缓存余量'],
 ['cancel','取消当前题的后台命令'],
 ['compact','在本轮结束后压缩上下文'],
 ['effort','选择思考模式、强度和预算'],
 ['model','查看并选择模型'],
 ['env','选择新题使用的运行环境'],
 ['checkpoint','在安全边界保存当前进度'],
 ['feedback','录入候选答案的判题结果'],
 ['tab','选择要查看的面板'],
 ['tool','展开指定序号的工具结果'],
 ['read','查看当前题工作目录中的文件'],
 ['archive','归档当前题的一条补充消息'],
 ['help','查看命令和快捷键'],
 ['skills','查看或搜索已安装的技能'],
 ['use-skill','将技能读取请求加入当前题'],
 ['discard','清空当前输入草稿'],
 ['quit','保存并退出终端'],
].map(([name,description])=>({name,description}));

const effortLabels={off:'关闭思考',low:'低强度',medium:'中等强度',high:'高强度',xhigh:'最高强度'};
export const effortOptions=EFFORTS.map(value=>({value,label:effortLabels[value]+' · '+value}));

export const budgetLabel=tokens=>tokens===-1?'无独立上限':tokens+' tokens';
export function effortBudgetOptions(current,limit){
 return [
  {value:'keep',label:'保留现有上限',description:budgetLabel(current)},
  ...[1024,2048,4096,-1].filter(tokens=>tokens<limit)
   .map(tokens=>({value:String(tokens),label:budgetLabel(tokens)})),
  {value:'custom',label:'自定义上限',description:'输入 token 数'},
 ];
}

export const panelOptions=[
 ['output','对话与推理'],['jobs','后台命令'],['budget','用量与预算'],['files','输出文件'],
 ['inbox','补充消息'],['candidates','候选答案'],['compact','压缩记录'],['queue','题目队列'],
].map(([value,label])=>({value,label,description:value}));

export const verdictOptions=[
 ['correct','通过'],['incorrect','错误'],['pending','待确认'],
].map(([value,label])=>({value,label,description:value}));
