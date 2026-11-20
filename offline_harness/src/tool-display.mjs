// Human presentation only; task files and the model's structured results stay intact.
export function toolText(name,text){
 if(!['run_command','wait_job','submit_flag'].includes(name))return text;
 let data;try{data=JSON.parse(text);}catch{return text;}
 if(!data||typeof data!=='object')return text;
 if(name==='submit_flag'){
  const statuses={awaiting_review:'待人工确认',pending:'等待判题',correct:'通过',incorrect:'错误'};
  return [statuses[data.status]??data.status,data.review_id,data.message].filter(Boolean).join(' · ');
 }
 const state={running:'运行中',started:'运行中',finished:'已结束',cancelled:'已取消',unknown_exit:'退出状态未知',unknown_launch:'启动状态待确认',job_missing:'任务记录不存在',job_record_missing:'启动记录不存在',launch_failed:'启动失败',error:'错误'};
 const header=[data.job_id,state[data.status]??data.status,data.exit_code!==undefined&&data.exit_code!==null?'退出码 '+data.exit_code:undefined].filter(Boolean).join(' · ');
 return [header,data.stdout, data.stderr?'stderr:\n'+data.stderr:undefined,data.error?'错误：'+data.error:undefined,data.message,
  data.stdout_file?'完整 stdout：'+data.stdout_file:undefined,data.stderr_file?'完整 stderr：'+data.stderr_file:undefined].filter(x=>x!==undefined&&x!=='').join('\n');
}
