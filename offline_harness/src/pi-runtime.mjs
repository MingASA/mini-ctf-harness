// The pinned 1.5.0 package exports its whole CLI from its barrel. Import its
// native modules directly so file reads do not initialize CLI/MCP extensions.
const entry=import.meta.resolve('@earendil-works/pi-coding-agent');
export const {loadSkillsFromDir,formatSkillsForPrompt}=await import(new URL('./core/skills.js',entry));
export const {createReadTool}=await import(new URL('./core/tools/read.js',entry));
export const {convertToPng}=await import(new URL('./utils/image-convert.js',entry));
