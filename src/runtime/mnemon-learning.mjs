import path from 'node:path';
import {pathToFileURL} from 'node:url';
/** Host-only adapter. No model-supplied operation, path, source or module name. */
export async function createMnemonLearningStore({moduleRoot,dataDir,workspace,dshHome,loadModule=url=>import(url)}){
 if(![moduleRoot,dataDir,workspace,dshHome].every(value=>typeof value==='string'&&path.isAbsolute(value)))throw Error('Mnemon learning paths must be absolute');
 const [skillModule,documentModule]=await Promise.all([
  loadModule(pathToFileURL(path.join(moduleRoot,'dsh-mnemon-source-skills/lib/index.js')).href),
  loadModule(pathToFileURL(path.join(moduleRoot,'dsh-mnemon-source-documents/lib/index.js')).href),
 ]);
 const skills=skillModule.createSkillsMemorySource({dataDir,dshHome,agentsHome:path.join(dataDir,'isolated-agents-home')}).create({configuration:{},sourceInstanceKey:'source:include:mnemon-source-skills'});
 const documents=documentModule.createDocumentsMemorySource({dataDir,limitBytes:10*1024*1024}).create({configuration:{},sourceInstanceKey:'source:include:mnemon-source-documents'});
 const scope={workspaceId:workspace};
 async function manage(source,mode,operation,input){return (await source.manage({scope,mode,operation,input,confirmed:mode==='mutate',signal:AbortSignal.timeout(10000)})).value;}
 async function saveSkill(recipe,content){
  if(!/^qq-[a-z][a-z0-9-]{0,47}$/.test(recipe.id)||recipe.count<3)throw Error('Unsupported learned QQ skill');
  const catalog=await manage(skills,'read','catalog',{}),existing=catalog.skills.find(s=>s.name===recipe.id&&!s.shadowedBy);
  if(existing)return {created:false};
  await manage(skills,'mutate','skill-create',{name:recipe.id,description:recipe.title,content,root:'project-dsh'});
  return {created:true};
 }
 async function saveDiary(date,content){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof content!=='string'||content.length>5000)throw Error('Invalid diary archive');
  const title=date+' · 柚子的日记',snapshot=await manage(documents,'read','snapshot',{});
  const existing=snapshot.documents.find(d=>d.title===title);
  if(existing){const document=await manage(documents,'read','document',{id:existing.id});if(document.content!==content)throw Error('Existing Mnemon diary differs; preserve both for review');return {id:existing.id,created:false};}
  const result=await manage(documents,'mutate','mutate',{action:'create',title,description:'仅供主人查阅的柚子每日线上日记；只依据允许群的公开内容。',content,sourcePaths:['日记/'+date+'.md']});
  return {id:result.document.id,created:true};
 }
 return {saveSkill,saveDiary,backend:'mnemon-native-sources'};
}
