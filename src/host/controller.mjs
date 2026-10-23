import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createControlStore,ControlError,assertBlockTarget,sanitizeValue} from '../control/store.mjs';
import {toRuntimeConfig} from './config-mapper.mjs';
import {createDeploymentRuntime} from '../runtime/deployment-runtime.mjs';
import {createTokenLedger} from '../runtime/token-ledger.js';
import {createDiaryReader} from '../runtime/diary-admin.mjs';
import {readReportArtifact} from './report-reader.mjs';
const principal=Object.freeze({kind:'management'});
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});try{fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}}

export async function createController({controlDir,configFile,initialConfig,legacy={},supervisor,validateRuntime=async()=>{}}){
 let pendingReconnect=false,closed=false,store,queue=Promise.resolve(),restoreRunning=false;
 const consoleToken=legacy.consoleToken||randomUUID().replaceAll('-','');
 const runtimeConfig=c=>{const value=toRuntimeConfig(c,legacy);value.consoleToken=consoleToken;return value;};
 async function gatedConfig(next,previous){
  if(!supervisor.status().running)return;
  const oldStatus=await supervisor.request('status');restoreRunning=oldStatus.paused!==true;
  await supervisor.request('pause');
  const changed=JSON.stringify(next.connection)!==JSON.stringify(previous.connection)||JSON.stringify(next.paths)!==JSON.stringify(previous.paths);
  pendingReconnect||=changed;
  const gated=runtimeConfig(changed?{...next,connection:previous.connection,paths:previous.paths}:next);gated.deployment.inferenceEnabled=false;gated.deployment.outgoingEnabled=false;gated.deployment.reportsEnabled=false;gated.deployment.proactive.enabled=false;gated.deployment.dailyLearning.enabled=false;
  atomic(configFile,gated);await supervisor.request('config',gated);
 }
 store=await createControlStore({dir:controlDir,initialConfig,onCommit:gatedConfig});
 async function activate({resume=false}={}){
  const config=store.rawConfig();
  if(!config.runtime.enabled){atomic(configFile,runtimeConfig(config));await supervisor.stop();return;}
  if(pendingReconnect)return;
  await validateRuntime(config);
  const next=runtimeConfig(config);atomic(configFile,next);
  const newlyStarted=!supervisor.status().running;
  if(!newlyStarted)await supervisor.request('config',next);else await supervisor.start();
  if(resume||newlyStarted)await supervisor.request('resume');
 }
 async function offlineBoundary(op,payload={}){
  const c=store.rawConfig();if(!c.paths.stateDir)return [];
  const r=createDeploymentRuntime({stateDir:c.paths.stateDir,config:runtimeConfig(c)});
  try{if(op==='blacklist.list')return r.listIgnoredMembers();if(op==='blacklist.add')return r.addIgnoredMember({subjectId:payload.userId,reason:payload.reason});return r.releaseIgnoredMember({subjectId:payload.userId});}finally{r.close();}
 }
 async function boundary(op,payload){return supervisor.status().running?supervisor.request(op,payload):offlineBoundary(op,payload);}
 async function diaryList(){const workspace=store.rawConfig().paths.workspace;return workspace?createDiaryReader({workspace}).list():[];}
 async function diary(date){return createDiaryReader({workspace:store.rawConfig().paths.workspace}).read(date);}
 function metrics(){
  const stateDir=store.rawConfig().paths.stateDir;if(!stateDir)return store.snapshot().metrics;
  try{const totals=createTokenLedger({file:path.join(stateDir,'token-usage.jsonl')}).summary().totals,b=totals.buckets;return {inputTokens:b.cacheMiss+b.cacheHit+b.cacheWrite,uncachedInputTokens:b.cacheMiss,cacheReadTokens:b.cacheHit,cacheWriteTokens:b.cacheWrite,outputTokens:b.output,requests:totals.steps,cacheHitRate:totals.cacheHitRate,latencyMs:null};}catch{return {...store.snapshot().metrics,available:false};}
 }
 async function snapshot(){
  const base=store.snapshot(),running=supervisor.status().running;
  const result=await Promise.allSettled([running?supervisor.request('status'):null,boundary('blacklist.list',{}),diaryList(),running?supervisor.request('reports.list'):[]]);
  const values=result.map(x=>x.status==='fulfilled'?x.value:null),runtime=values[0]??{};
  const state=closed?'disabled':!base.config.runtime.enabled?'disabled':supervisor.status().lastError?'error':pendingReconnect?'paused':!running?'stopped':runtime.paused?'paused':'running';
  const blacklist=Array.isArray(values[1])?values[1].map(row=>({...row,userId:String(row.userId??row.subjectId),reason:row.reason??'',source:row.source??'automatic'})):[];
  return {...base,status:{...supervisor.status(),...runtime,state,pendingReconnect,connected:runtime.connected??runtime.qq?.connected??runtime.snowluma?.connected??false},blacklist,diaries:values[2]??[],reports:values[3]??[],metrics:metrics()};
 }
 async function perform(action,payload,revision){
  if(closed)throw new ControlError('CLOSED','Plugin disabled',503);
  if(revision!==store.snapshot().revision)throw new ControlError('REVISION_CONFLICT','配置已变化，请刷新后重试',409);
  if(action==='config.update'||action==='config.import'){
   const result=action==='config.update'?await store.update(payload.patch,revision,principal):await store.importConfig(payload.config,revision,principal);
   await activate({resume:restoreRunning});restoreRunning=false;return result;
  }
  if(action==='config.export')return store.exportConfig(principal);
  if(action==='runtime.reconnect'){await supervisor.stop();pendingReconnect=false;await activate({resume:true});await store.audit(action,{},principal);return {reconnected:true};}
  if(action==='runtime.pause'||action==='runtime.resume'){
   if(action==='runtime.resume'){if(!store.rawConfig().runtime.enabled)throw new ControlError('DISABLED','请先启用运行模块',409);await activate({resume:true});}else if(supervisor.status().running)await supervisor.request('pause');
   await store.audit(action,{},principal);return {paused:action==='runtime.pause'};
  }
  if(action==='blacklist.add'||action==='blacklist.release'){
   if(action==='blacklist.add')assertBlockTarget(store.rawConfig(),payload.userId);
   else if(!/^[1-9]\d{0,19}$/.test(String(payload.userId)))throw new ControlError('VALIDATION','QQ 号无效');
   if(payload.reason!==undefined&&(typeof payload.reason!=='string'||payload.reason.length>500))throw new ControlError('VALIDATION','黑名单备注过长');
   const value=await boundary(action,{userId:payload.userId,reason:payload.reason??''});await store.audit(action,{userId:payload.userId},principal);return sanitizeValue(value);
  }
  if(action==='diary.backfill'||action==='reports.run'){
   if(!supervisor.status().running)throw new ControlError('DISABLED','运行模块未启动',409);
   let request=payload;
   if(action==='diary.backfill'){
    const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
    if(!valid(payload.from)||!valid(payload.to))throw new ControlError('VALIDATION','补跑日期无效');
    const start=Date.parse(payload.from+'T00:00:00Z'),end=Date.parse(payload.to+'T00:00:00Z');
    if(end<start||end-start>6*86400000)throw new ControlError('VALIDATION','每次补跑限1至7天');
    request={dates:Array.from({length:1+(end-start)/86400000},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10))};
   }
   const value=await supervisor.request(action,request,action==='diary.backfill'?7*190000:190000);await store.audit(action,payload,principal);return value;
  }
  throw new ControlError('UNKNOWN_ACTION','不支持的管理操作');
 }
 function dispatch(action,payload,revision){
  // Long model work must not hold the management mutation queue or block pause/revocation.
  if(action==='diary.backfill'||action==='reports.run')return perform(action,structuredClone(payload),revision);
  const captured=structuredClone(payload),result=queue.then(()=>perform(action,captured,revision));queue=result.catch(()=>{});return result;
 }
 return {store,snapshot,diary,report:request=>readReportArtifact(store.rawConfig(),request),dispatch,prepare:()=>atomic(configFile,runtimeConfig(store.rawConfig())),start:()=>activate({resume:true}),async close(){closed=true;await supervisor.stop();await queue;await store.close();}};
}
