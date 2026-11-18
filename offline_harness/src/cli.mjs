#!/usr/bin/env node
import fs from 'node:fs';
import {Skills,DEFAULT_SKILLS_DIR} from './skills.mjs';
import {runTask} from './runner.mjs';
import {Startup,readStartConfig,DEFAULT_START_CONFIG} from './startup.mjs';
import {Contest} from './contest.mjs';
import {CompetitionTerminal} from './terminal.mjs';
import {assertExperimentIdle} from './native.mjs';
const args=process.argv.slice(2);
try {
  if(['help','--help'].includes(args[0]))console.log('Usage: start [CONFIG.json] [--env NAME] [--model ID] [--projector-device cpu|gpu] [--target PRIVATE_URL] | doctor [CONFIG.json] | prepare [CONFIG.json] [--no-model] | terminal CONFIG.json | skills list|check|search');
  else if(args[0]==='skills') {
    const action=args[1]||'list',root=args[action==='search'?3:2]||DEFAULT_SKILLS_DIR;
    const knowledge=new Skills(root);
    if(action==='check')console.log(JSON.stringify(knowledge.verify(),null,2));
    else if(action==='list')console.log(JSON.stringify(knowledge.docs.map(({name,description,filePath})=>({name,description,filePath})),null,2));
    else if(action==='search')console.log(JSON.stringify(knowledge.search(args[2]||''),null,2));
    else throw Error('Usage: skills list|check [SKILLS_DIR] | skills search QUERY [SKILLS_DIR]');
  }
  else if(['start','doctor','prepare'].includes(args[0])||(args[0]==='terminal'&&args[1])) {
    const start=args[0]!=='terminal';let startup,config,startOptions={};
    if(start){const opts={},fields={'--env':'environment','--model':'model','--target':'target','--projector-device':'projectorDevice'};let file;for(let i=1;i<args.length;i++){if(Object.hasOwn(fields,args[i])){if(!args[i+1])throw Error('Missing value for '+args[i]);opts[fields[args[i]]]=args[++i];}else if(args[i]==='--no-model')opts.noModel=true;else if(args[i].startsWith('-'))throw Error('Unknown option '+args[i]);else if(!file)file=args[i];else throw Error('Unexpected argument '+args[i]);}startOptions=opts;const read=readStartConfig(file??DEFAULT_START_CONFIG,opts);config=read.config;startup=new Startup(config,read.file);if(args[0]==='doctor'){console.log(JSON.stringify(startup.doctor(),null,2));process.exit(0);}if(args[0]==='prepare'){const c=new Contest(config,{provision:(...a)=>startup.provision(...a)});startup.attach(c);try{console.log(JSON.stringify(await startup.start(c,{noModel:opts.noModel}),null,2));}finally{await c.close();}process.exit(0);}}else config=JSON.parse(fs.readFileSync(args[1],'utf8'));
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Competition terminal needs an interactive TTY');
    const contest=new Contest(config,startup?{provision:(...args)=>startup.provision(...args)}:{});if(startup)startup.attach(contest);
    const interrupt=()=>terminal.interrupt(),terminate=()=>terminal.close();
    const terminal=new CompetitionTerminal(contest,{onClose:()=>{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.exitCode=0;}});terminal.start();
    process.once('SIGTERM',terminate);process.on('SIGINT',interrupt);if(startup)startup.start(contest,{noModel:startOptions.noModel}).catch(()=>{});
  }
  else if(args[0]==='guard') {assertExperimentIdle();console.log('Existing experiment is not running.');}
  else if(args[0]==='run' && args[1] && args[2]) {
    const task=JSON.parse(fs.readFileSync(args[1],'utf8')),config=JSON.parse(fs.readFileSync(args[2],'utf8'));
    console.log(JSON.stringify(await runTask(task,config,{resume:args.includes('--resume')}),null,2));
  } else throw Error('Usage: node src/cli.mjs guard | run PUBLIC_TASK.json CONFIG.json [--resume] | terminal COMPETITION_CONFIG.json | skills list|check|search');
} catch(error) {console.error(error.message);process.exitCode=1;}
