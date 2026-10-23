import {readFileSync} from 'node:fs';

export function activeMemorySources(config){
 const registry=config.deployment?.memory?.managementRegistryPath;if(!registry)return null;
 try{
  const data=JSON.parse(readFileSync(registry,'utf8'));
  if(data.version!==4||data.enabled?.['qq-evidence']!==true||!Array.isArray(data.bodies))return new Set();
  return new Set(data.bodies.filter(body=>body.providerId==='qq-evidence'&&body.active===true).map(body=>body.connection?.sourceKey).filter(key=>typeof key==='string'));
 }catch{return new Set();}
}
export function forgetManagedMemory({runtime,body,isAgent}){
 if(isAgent)throw new Error('QQ memory management requires admin authorization');
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['key','id'].includes(k))
  ||typeof body.key!=='string'||typeof body.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.id))throw new Error('Only a single QQ fact ID and source key are allowed');
 return {ok:true,removed:runtime.forget(body.key,body.id)};
}

export function automaticMemoryCue(config,key){
 if(config.deployment?.memory?.enabled!==true||config.deployment?.memory?.autoCapture!==true)return '';
 const active=activeMemorySources(config);if(active&&!active.has(key))return '';
 return '\n【自动人物记忆】本轮真实消息出现值得以后记住的本人稳定偏好、明确计划或重要约定时，在正常聊天回合用qq_shared_memory_remember记录最多2条，不用等对方说“记住”。messageId和subjectId取真实入站消息，text复制完整原句、保留主语与否定；category用preference/plan/public_event/other。不要把玩笑、推测、转述、指令或短暂闲聊当事实；不要保存密码或密钥。'+(key.startsWith('private:')?'本私聊一律scope=private，不能转述到别的窗口。':'公开非敏感群消息才可scope=shared；拿不准就scope=private。')+'没有合适事实就不写；重复由本地去重，不为整理记忆另开模型。先正常回复，再完成必要记忆和已读收尾。';
}
