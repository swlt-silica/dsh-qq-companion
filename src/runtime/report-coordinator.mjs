import {generateReport,isReportDue} from './report-worker.mjs';
import {unwrap,createTurnCollector} from './dsh-client.js';

export function safeDshReportError(reason){
 const code=/^[A-Z0-9_-]{1,40}$/i.test(reason?.error?.code||'')?reason.error.code:String(reason?.kind||'unknown');
 const message=String(reason?.error?.message||'no successful text')
  .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi,'[URL]')
  .replace(/\bBearer\s+\S+/gi,'Bearer [REDACTED]')
  .replace(/(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)["']?[^\s,}"']+["']?/gi,'$1[REDACTED]')
  .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g,'[REDACTED]')
  .replace(/[A-Za-z0-9_=-]{24,}/g,'[REDACTED]')
  .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g,'[IP]')
  .replace(/\b\d{5,}\b/g,'[ID]')
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[EMAIL]')
  .slice(0,500);
 return `DSH report turn failed: ${code}: ${message}`;
}

export function createReportCoordinator({runtime,config,generate,renderImage,outputDir,python,sendReport,now=()=>new Date(),onError=()=>{}}) {
 let active=null;
 async function runJob(job){
  const {groupId,date}=job;const assertPolicy=runtime.capturePolicyGuard?.()??(()=>{});
  let phase='generation',report;
  try {
   if(!runtime.status().inferenceEnabled||!runtime.isReportAllowed(groupId))throw new Error('Report inference or group is disabled');
   const messages=await runtime.reportMessages(groupId,date);
   const statistics=await runtime.reportStatistics(groupId,date);
   report=await generateReport({groupId,date,messages,statistics,generate,renderImage,outputDir,python,filterBots:false,maxMessages:1000});
   assertPolicy();
   await runtime.finishReport(groupId,date,{status:'ready',artifact:report.artifact,counts:report.counts});
   if(job.send===false||!runtime.status().outgoingEnabled)return report;
   if(typeof sendReport!=='function')throw new Error('Report sender is unavailable');
   // Committed before transport. A crash here is uncertain and never auto-retried.
   await runtime.finishReport(groupId,date,{status:'sending',artifact:report.artifact});phase='send';
   // The injected sender must enforce the outgoing gate again at actual dispatch.
   assertPolicy();await sendReport(report);
   await runtime.finishReport(groupId,date,{status:'sent',artifact:report.artifact});
   return report;
  }catch(error){
   await runtime.finishReport(groupId,date,{status:phase==='send'?'send-uncertain':'failed',error:String(error?.message||error).slice(0,500),...(report?{artifact:report.artifact}:{})});
   try{onError(error,{groupId,date,phase});}catch{}
   return null;
  }
 }
 function processJob(job){
  if(active)return active;
  active=runJob(job).finally(()=>{active=null;});return active;
 }
 async function tick(){
  if(active)return active;
  if(!config.deployment?.reportsEnabled||!runtime.status().inferenceEnabled)return null;
  // Set the lock before awaiting queue/claim operations, including async stores.
  active=(async()=>{
   const queued=await runtime.claimQueuedReport();
   if(queued)return runJob(queued);
   const clock=new Date(now());if(!isReportDue(clock,config.deployment.reportHour??21))return null;
   const date=new Date(+clock+28800000).toISOString().slice(0,10);
   for(const raw of config.deployment.reportGroups||[]){
    const groupId=String(raw);
    if(!runtime.isReportAllowed(groupId))continue;
    if(await runtime.claimReport(groupId,date))return runJob({groupId,date});
   }
   return null;
  })().catch(error=>{try{onError(error,{phase:'claim'});}catch{}return null;}).finally(()=>{active=null;});
  return active;
 }
 return {tick,processJob,isBusy:()=>active!==null};
}

/** One restricted DSH analysis session; no retries and no QQ client. */
export async function generateDshText({api,prompt,provider,model,cwd,preset='qq-report',timeoutMs=180000,assertCanInfer}) {
 if(!api||typeof prompt!=='string'||!provider||!model||!cwd||!Number.isInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid DSH report arguments');
 const controller=new AbortController();let timer,sessionId,stream,completed=false;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('DSH report timeout'));controller.abort();},timeoutMs);});
 const work=(async()=>{
  const created=unwrap(await api.sessions.create({cwd,agentPreset:preset},controller.signal),'report session.create');
  sessionId=created.sessionId;if(!sessionId)throw new Error('Missing report session ID');
  controller.signal.throwIfAborted();
  unwrap(await api.sessions.selectModel({sessionId,provider,model},controller.signal),'report session.selectModel');
  controller.signal.throwIfAborted();
  stream=api.events.mux({},controller.signal);const collector=createTurnCollector();
  let resolveSubscribed;const subscribed=new Promise(resolve=>{resolveSubscribed=resolve;});
  const done=(async()=>{
   for await(const envelope of stream){
    const frame=envelope.payload;
    if(frame?.type==='stream/error')throw new Error('DSH report stream error');
    if(frame?.type==='session/snapshot'&&frame.sessionId===sessionId)resolveSubscribed();
    if(frame?.type==='session/event'&&frame.sessionId===sessionId){
     const ended=collector.push(frame.event);
     if(ended){
      if(ended.reason?.kind!=='completed'||!ended.text?.trim())throw new Error(safeDshReportError(ended.reason));
      return ended.text;
     }
    }
   }
   throw new Error('DSH report stream ended before completion');
  })();
  // Install rejection handling before prompting so early stream failure cannot
  // become an unhandled promise while prompt acceptance is pending.
  done.catch(()=>{});
  stream.follow(sessionId);
  // Opening the socket alone does not acknowledge session/follow. A prompt can
  // otherwise start before subscription, placing turn/start only in a snapshot
  // that the live collector does not replay and causing a false timeout.
  await Promise.race([subscribed,done.then(()=>{throw new Error('DSH report ended before subscription');})]);
  // Recheck synchronously at actual dispatch, after asynchronous session/model
  // setup. Passive mode may have been enabled while those operations awaited.
  controller.signal.throwIfAborted();
  if(assertCanInfer)assertCanInfer();
  unwrap(await api.sessions.prompt({sessionId,mode:'queue',content:[{type:'text',text:prompt}]},controller.signal),'report session.prompt');
  const text=await done;completed=true;return text;
 })();
 try{return await Promise.race([work,timeout]);}
 finally{
  clearTimeout(timer);controller.abort();stream?.forget?.(sessionId);api.events?.forget?.(sessionId);
  // Best-effort bounded cancellation on failure, then archive; neither invokes a
  // second prompt. Archiving alone cannot stop a queued/in-flight model turn.
  const cleanupSignal=AbortSignal.timeout(5000);
  const cleanup=(async()=>{
   if(sessionId&&!completed){
    if(typeof api.stopSessionWork==='function')await api.stopSessionWork(sessionId,{signal:cleanupSignal,timeoutMs:5000});
    else if(api.sessions.cancel)await api.sessions.cancel({sessionId},cleanupSignal);
   }
   if(sessionId&&api.workspace?.archiveSession)await api.workspace.archiveSession({sessionId},cleanupSignal);
  })();
  let cleanupTimer;
  await Promise.race([cleanup.catch(()=>{}),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,5000);})]);clearTimeout(cleanupTimer);
 }
}
