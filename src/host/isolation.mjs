import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
// A shared memory provider must explicitly exclude QQ roots and descendants.
export async function verifyMemoryIsolation(config){
 if(config.daily.enabled){
  for(const file of [path.join(config.paths.workspace,'PERSONA.md'),path.join(config.paths.mnemonModuleRoot,'dsh-mnemon-source-documents','lib','index.js'),path.join(config.paths.mnemonModuleRoot,'dsh-mnemon-source-skills','lib','index.js')]){
   if(!fs.existsSync(file))throw Error('Daily learning prerequisites are unavailable; inference remains disabled');
  }
 }
 if(!config.paths.mnemonModuleRoot)throw Error('Mnemon QQ isolation must be explicitly configured before inference');
 const file=path.join(config.paths.mnemonModuleRoot,'dsh-mnemon','lib','qq-session-policy.mjs');
 if(!fs.existsSync(file))throw Error('Mnemon QQ lifecycle isolation is unverified; inference remains disabled');
 const {excludesQQMemory}=await import(pathToFileURL(file).href);
 if(typeof excludesQQMemory!=='function')throw Error('Mnemon QQ isolation contract unavailable');
 const root={id:'companion-isolation-root',session:{header:{agentPreset:'qq-yuzu'}}},report={id:'companion-isolation-report',session:{header:{agentPreset:'qq-report'}}},child={id:'companion-isolation-child',session:{header:{agentPreset:'standard',parentSession:root.id,origin:'subagent'}}};
 if(!excludesQQMemory(root,()=>undefined)||!excludesQQMemory(report,()=>undefined)||!excludesQQMemory(child,id=>id===root.id?root:undefined))throw Error('Mnemon QQ isolation probe failed');
}
