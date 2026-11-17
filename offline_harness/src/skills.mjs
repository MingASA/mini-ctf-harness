import fs from 'node:fs';
import path from 'node:path';
import {loadSkillsFromDir,formatSkillsForPrompt} from './pi-runtime.mjs';
import {hash} from './store.mjs';

export const DEFAULT_SKILLS_DIR=new URL('../../.agents/skills/',import.meta.url).pathname;
// Pi owns discovery, frontmatter parsing, validation and prompt formatting.
export class Skills {
 constructor(root=DEFAULT_SKILLS_DIR){
  this.root=path.resolve(root);
  const {skills,diagnostics}=loadSkillsFromDir({dir:this.root,source:'project'});
  this.docs=skills;this.diagnostics=diagnostics;
 }
 skill(name){const skill=this.docs.find(s=>s.name===name);if(!skill)throw Error('Unknown skill name');return skill;}
 search(query){const terms=query.toLowerCase().split(/\s+/).filter(Boolean);return this.docs.filter(s=>terms.some(t=>(s.name+' '+s.description).toLowerCase().includes(t)));}
 verify(){
  const files=[];
  const walk=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile()){const bytes=fs.readFileSync(file);files.push({path:path.relative(this.root,file),bytes:bytes.length,sha256:hash(bytes)});}}};
  if(fs.existsSync(this.root))walk(this.root);
  return {skills:this.docs.length,diagnostics:this.diagnostics,files};
 }
}
export const skillsPrompt=skills=>formatSkillsForPrompt(skills?.docs||[]);
