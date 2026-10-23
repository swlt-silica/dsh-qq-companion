/** Private child IPC control. Only the native authenticated host can reach this channel. */
function mergeInPlace(target,next){
 for(const [key,value] of Object.entries(next)){
  if(['__proto__','constructor','prototype'].includes(key))throw Error('Unsafe configuration key');
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   if(!target[key]||typeof target[key]!=='object'||Array.isArray(target[key]))target[key]={};
   if(key==='overrides')for(const old of Object.keys(target[key]))delete target[key][old];
   mergeInPlace(target[key],value);
  }else target[key]=structuredClone(value);
 }
 return target;
}
export function createRuntimeControl({config,runtime,daily,reports,revoke=()=>{},shutdown=async()=>{},extraStatus=()=>({}),isPaused=()=>false,setPaused=()=>{}}){
 let paused=isPaused(),closed=false,saved={inferenceEnabled:config.deployment?.inferenceEnabled===true,outgoingEnabled:config.deployment?.outgoingEnabled===true};
 const status=()=>({...runtime?.status(),...extraStatus(),paused:paused||isPaused(),closed,daily:{available:!!daily,...(daily?.status()??{enabled:false})}});
 const closeGates=()=>{config.deployment??={};config.deployment.inferenceEnabled=false;config.deployment.outgoingEnabled=false;runtime?.revokePolicy?.();revoke();};
 async function request(op,payload={}){
  if(closed&&op!=='status')throw Error('Runtime is shut down');
  switch(op){
   case 'status':return status();
   case 'config':{
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!payload.allow||!payload.deployment)throw Error('Complete legacy configuration required');
    const candidate=structuredClone(payload); // Validate safety before revoking.
    mergeInPlace({},candidate);
    closeGates();mergeInPlace(config,candidate);
    if(paused){saved={inferenceEnabled:config.deployment.inferenceEnabled===true,outgoingEnabled:config.deployment.outgoingEnabled===true};config.deployment.inferenceEnabled=false;config.deployment.outgoingEnabled=false;}
    return status();
   }
   case 'pause':if(!paused){saved={inferenceEnabled:config.deployment?.inferenceEnabled===true,outgoingEnabled:config.deployment?.outgoingEnabled===true};paused=true;}setPaused(true);closeGates();return status();
   case 'resume':if(paused){mergeInPlace(config.deployment,saved);paused=false;}setPaused(false);return status();
   case 'blacklist.list':return runtime.listIgnoredMembers();
   case 'blacklist.add':{const result=runtime.addIgnoredMember({subjectId:payload.subjectId??payload.userId,reason:payload.reason??''});runtime.revokePolicy?.();revoke();return result;}
   case 'blacklist.release':return runtime.releaseIgnoredMember({subjectId:payload.subjectId??payload.userId});
   case 'diary.list':return daily?.listDiaries()??[];
   case 'diary.read':if(!daily)throw Error('Daily learning is unavailable');return daily.readDiary(String(payload.date??''));
   case 'diary.backfill':if(!daily)throw Error('Daily learning is unavailable');return daily.backfill(payload);
   case 'reports.list':return runtime.listReports();
   case 'reports.run':{
    const {groupId,date}=payload;if(!runtime.isReportAllowed(groupId))throw Error('Report group is not allowed');
    if(reports?.isBusy?.())throw Error('Report coordinator is busy; another report is already running');
    if(!reports||!runtime.claimReport(groupId,date))throw Error('Report unavailable or already claimed');
    return reports.processJob({groupId:String(groupId),date,send:false});
   }
   case 'shutdown':closed=true;paused=true;setPaused(true);closeGates();await shutdown();return status();
   default:throw Error('Unsupported runtime operation');
  }
 }
 return {request,status};
}
export function bindRuntimeIpc(control,channel=process){
 const listener=message=>{
  if(!message||typeof message.id!=='string'||typeof message.op!=='string')return;
  // Config and gates mutate synchronously. Long model work must never delay pause/shutdown.
  void (async()=>{try{const value=await control.request(message.op,message.payload);channel.send?.({id:message.id,ok:true,value});}catch(error){channel.send?.({id:message.id,ok:false,error:{code:'RUNTIME_REQUEST',message:String(error.message).slice(0,500)}});}})();
 };
 channel.on('message',listener);channel.send?.({event:'ready',value:control.status()});
 return ()=>channel.off('message',listener);
}
