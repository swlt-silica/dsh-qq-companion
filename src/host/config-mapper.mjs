import {defaultConfig} from '../control/config.mjs';

export function initialFromLegacy(legacy={},options={}){
 const c=defaultConfig(),d=legacy.deployment??{},learning=d.dailyLearning??{};
 c.connection={onebotWs:legacy.snowluma?.wsUrl??'',onebotHttp:legacy.snowluma?.httpUrl??'',accessToken:legacy.snowluma?.accessToken??'',wsAccessToken:legacy.snowluma?.wsAccessToken??legacy.snowluma?.accessToken??'',dshUrl:legacy.dsh?.baseUrl??'',dshToken:legacy.dsh?.authToken??''};
 c.identity={ownerQQ:String(legacy.ownerQQ??''),selfQQ:String(options.selfQQ??legacy.selfQQ??''),botName:options.botName??legacy.botName??'QQ Companion'};
 c.access={groups:(legacy.allow?.groups??[]).map(String),private:(legacy.allow?.private??[]).map(String)};
 c.runtime={enabled:options.enabled===true,inference:d.inferenceEnabled!==false,outgoing:d.outgoingEnabled!==false};
 c.daily={...c.daily,enabled:learning.enabled!==false,time:learning.time??'00:05',includeOwnerPrivate:learning.includeOwnerPrivate===true,sampleChars:learning.sampleChars??16000,skillMinSuccesses:learning.skillMinSuccesses??3};
 c.reports={enabled:d.reportsEnabled!==false,hour:d.reportHour??21,groups:(d.reportGroups??[]).map(String).filter(id=>c.access.groups.includes(id))};
 c.paths={stateDir:options.stateDir??'',workspace:options.workspace??learning.workspaceDir??'',dshHome:options.dshHome??'',mnemonModuleRoot:options.mnemonModuleRoot??learning.mnemonModuleRoot??'',mnemonDataDir:options.mnemonDataDir??learning.mnemonDataDir??''};
 return c;
}
export function toRuntimeConfig(c,legacy={}){
 const result=structuredClone(legacy);result.ownerQQ=c.identity.ownerQQ;result.selfQQ=c.identity.selfQQ;result.botName=c.identity.botName;
 result.allow=structuredClone(c.access);result.deny={groups:[],private:[]};result.allowAllWhenEmpty=false;
 result.snowluma={...result.snowluma,wsUrl:c.connection.onebotWs,httpUrl:c.connection.onebotHttp,accessToken:c.connection.accessToken,wsAccessToken:c.connection.wsAccessToken??c.connection.accessToken,followDiscoveredEndpoint:false};
 result.dsh={...result.dsh,baseUrl:c.connection.dshUrl,authToken:c.connection.dshToken};
 result.agentPreset='qq-yuzu';result.slang={...result.slang,enabled:false,autoResearch:false};
 result.sessionCwd=c.paths.workspace;
 result.deployment={...result.deployment,inferenceEnabled:c.runtime.enabled&&c.runtime.inference,outgoingEnabled:c.runtime.enabled&&c.runtime.outgoing,
  reportsEnabled:c.runtime.enabled&&c.reports.enabled,reportHour:c.reports.hour,reportGroups:[...c.reports.groups],memberBoundaries:{enabled:true,afterWarningViolations:1},
  proactive:{...result.deployment?.proactive,...c.proactive,enabled:c.runtime.enabled&&c.proactive.enabled,driver:'companion',cooldownMs:c.proactive.minIntervalMinutes*60000,groupIdleMs:c.proactive.groupIdleMinutes*60000,privateIdleMs:c.proactive.privateIdleMinutes*60000},
  dailyLearning:{...result.deployment?.dailyLearning,...c.daily,enabled:c.runtime.enabled&&c.daily.enabled,workspaceDir:c.paths.workspace,mnemonModuleRoot:c.paths.mnemonModuleRoot,mnemonDataDir:c.paths.mnemonDataDir},
  cache:{enabled:c.cache.enabled},dshHome:c.paths.dshHome};
 result.socialV2={...result.socialV2,enabled:true};
 return result;
}
