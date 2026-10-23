const normalize=value=>String(value??'').replace(/^session-/,'');
export function evaluateOpportunity({sessionId,sessions,allowed,mode,paused,busy,inference,outgoing,budgetAvailable,activity,now=Date.now(),groupIdleMs=30*60000,privateIdleMs=2*3600000}={}){
 const deny=reason=>({ok:false,reason});
 if(typeof sessionId!=='string'||!sessionId.trim()||!sessions||typeof allowed!=='function')return deny('target');
 const matches=Object.entries(sessions).filter(([,id])=>normalize(id)===normalize(sessionId));
 if(matches.length!==1)return deny('target');
 const key=matches[0][0];if(!/^(group|private):[1-9]\d*$/.test(key)||!allowed(key))return deny('scope');
 if(mode!=='reserved2'||paused)return deny('mode');if(busy)return deny('busy');
 if(!inference||!outgoing)return deny('disabled');if(!budgetAvailable)return deny('budget-or-quiet');
 const last=Number(activity?.lastIncomingAt)||0;if(!last||last>now)return deny('no-activity');
 const idle=now-last;
 if(key.startsWith('group:')){
  if(idle<Math.max(60000,Number(groupIdleMs)||1800000))return deny('group-active');
  if(Number(activity?.messages15m)>=10||Number(activity?.participants15m)>=3)return deny('group-active');
 }else{
  if(idle<Math.max(60000,Number(privateIdleMs)||7200000))return deny('private-cooldown');
  // Ordinary replies do not consume the first idle greeting. The durable
  // budget gate distinguishes unsolicited dispatches and waits for a new human
  // message after one, including across restarts and silent model turns.
 }
 return {ok:true,key};
}
