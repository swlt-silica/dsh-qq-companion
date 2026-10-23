import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createDeploymentRuntime} from '../../src/runtime/deployment-runtime.mjs';
async function fixture(t, overrides={}){
 const instances=[];
 const h=await bridgeHarness({config:{deployment:{outgoingEnabled:false,inferenceEnabled:false,lockMode:true},socialV2:{enabled:true}},files:{'state/mode.json':{mode:'reserved2'}},globals:{...overrides,createDeploymentRuntime:args=>{const runtime=(overrides.createDeploymentRuntime??createDeploymentRuntime)(args);instances.push(runtime);return runtime;}}});
 t.after(async()=>{instances.forEach(r=>r.close());await h.close();});
 return h;
}
const event=(id,text)=>({message_id:id,user_id:123,self_id:999,time:Math.floor(Date.now()/1000),sender:{nickname:'fixture'},message:[{type:'text',data:{text}}]});
async function server(t,h){const s=h.startConsoleServer();if(!s.listening)await once(s,'listening');t.after(()=>new Promise(r=>s.close(r)));return 'http://127.0.0.1:'+s.address().port;}
const headers={'x-console-token':'fixture-console-token','content-type':'application/json'};

test('management memory route rejects agent/batch calls and needs console authentication',async t=>{
 const h=await fixture(t);const base=await server(t,h),body=JSON.stringify({key:'private:123',id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
 assert.equal((await fetch(base+'/api/deployment/memory-forget',{method:'POST',headers:{'content-type':'application/json'},body})).status,401);
 assert.equal((await fetch(base+'/api/deployment/memory-forget',{method:'POST',headers:{...headers,'x-agent-call':'1'},body})).status,403);
 assert.equal((await fetch(base+'/api/deployment/memory-forget',{method:'POST',headers,body:JSON.stringify({key:'private:123',ids:['a','b']})})).status,403);
 const r=await fetch(base+'/api/deployment/memory-forget',{method:'POST',headers,body});assert.equal(r.status,200);assert.equal((await r.json()).removed,false);
});

test('successful transport IDs archive own text even without a gateway echo',async t=>{
 const h=await fixture(t);h.cfg.deployment.outgoingEnabled=true;h.setSelfIdentity('柚子','999');
 await h.onebotSend('group',456,'真实已发消息');
 const base=await server(t,h);const before=await(await fetch(base+'/api/deployment/status',{headers})).json();
 assert.equal(before.messages,1,'must archive from successful transport before any echo');
 h.archiveSelfMessage('group',456,{...event(9001,'真实已发消息'),user_id:999,sender:{user_id:999}});
 const state=await(await fetch(base+'/api/deployment/status',{headers})).json();
 assert.equal(state.messages,1);assert.equal(h.calls.http.filter(c=>c.url.endsWith('/send_group_msg')).length,1);
});

test('self echoes are archived once without starting a conversation',async t=>{
 const h=await fixture(t);const own={...event(800,'柚子的真实发言'),user_id:999,sender:{user_id:999,nickname:'柚子'}};
 assert.equal(h.archiveSelfMessage('group',456,own),true);
 assert.equal(h.archiveSelfMessage('group',456,own),true);
 assert.equal(h.archiveSelfMessage('group',456,event(801,'群友')),false);
 const base=await server(t,h);const state=await(await fetch(base+'/api/deployment/status',{headers})).json();
 assert.equal(state.messages,1);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);
});
test('passive ingress archives exactly once and cannot wake DSH',async t=>{
 const h=await fixture(t);const base=await server(t,h);
 await h.handleIncoming('group',456,event(1,'柚子你好'),h.cfg);await h.handleIncoming('group',456,event(1,'柚子你好'),h.cfg);
 const r=await fetch(base+'/api/deployment/status',{headers});assert.equal(r.status,200);
 const state=await r.json();assert.equal(state.messages,1);assert.equal(state.inferenceEnabled,false);
 assert.equal(h.calls.created.length,0);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.sent.length,0);
});
test('legacy, V2, operator voice and low-level send paths fail closed',async t=>{
 const h=await fixture(t);const base=await server(t,h);
 for(const route of ['/api/send/group','/api/socialV2/send-message','/api/voice/send']){
  const r=await fetch(base+route,{method:'POST',headers,body:JSON.stringify({key:'group:456',groupId:456,message:'never send'})});
  assert.equal(r.status,403,route);
 }
 assert.throws(()=>h.sendToQQ('group:456','never send'),/关闭|disabled/);
 assert.equal(h.calls.sent.length,0);assert.equal(h.calls.http.filter(r=>r.url.includes('send_')).length,0);
});
test('QQ owner commands cannot change character or privileged mode',async t=>{
 const h=await fixture(t);const base=await server(t,h);
 await h.handleIncoming('private',123,event(1,'/role off'),h.cfg);
 assert.equal(h.calls.sent.length,0);
 const r=await fetch(base+'/api/mode',{method:'POST',headers,body:JSON.stringify({mode:'closed-agent'})});
 assert.equal(r.status,403);await h.refreshMode();assert.equal(h.getMode(),'reserved2');
});
test('shared-memory endpoint validates token against source conversation',async t=>{
 const h=await fixture(t);const base=await server(t,h);await h.handleIncoming('private',123,event(1,'明天我要参加面试'),h.cfg);
 const token=h.getSocialV2State('private:123').agentToken;
 let r=await fetch(base+'/api/socialV2/shared-memory',{method:'POST',headers:{...headers,'x-agent-token':token},body:JSON.stringify({key:'group:456',op:'query'})});
 assert.equal(r.status,403);
 h.cfg.deployment.inferenceEnabled=true;
 h.setMode('reserved2');h.socialV2.paused=false;
 r=await fetch(base+'/api/socialV2/shared-memory',{method:'POST',headers:{...headers,'x-agent-token':token},body:JSON.stringify({key:'private:123',op:'remember',messageId:'1',subjectId:'123',category:'plan',text:'明天我要参加面试',scope:'shared'})});
 assert.equal(r.status,200);assert.equal((await r.json()).scope,'private');
});

test('memory endpoint rejects paused, disabled, inactive-mode and revoked inference calls',async t=>{
 const h=await fixture(t);await h.handleIncoming('private',123,event(61,'我喜欢薄荷茶'),h.cfg);const token=h.getSocialV2State('private:123').agentToken;const base=await server(t,h);h.cfg.deployment.inferenceEnabled=true;
 const request=()=>fetch(base+'/api/socialV2/shared-memory',{method:'POST',headers:{...headers,'x-agent-token':token},body:JSON.stringify({key:'private:123',op:'remember',messageId:'61',subjectId:'123',category:'preference',text:'我喜欢薄荷茶'})});
 h.setMode('reserved2');h.socialV2.paused=true;assert.equal((await request()).status,403);h.socialV2.paused=false;
 h.cfg.socialV2.enabled=false;assert.equal((await request()).status,403);h.cfg.socialV2.enabled=true;
 h.setMode('chat');assert.equal((await request()).status,403);h.setMode('reserved2');
 h.cfg.deployment.inferenceEnabled=false;assert.equal((await request()).status,403);
});

test('speak-up opportunity route rejects model authority and passive/manual dispatch',async t=>{
 const h=await fixture(t);h.state.sessions['group:456']='alpha';const base=await server(t,h);
 let r=await fetch(base+'/api/socialV2/proactive-opportunity',{method:'POST',headers:{...headers,'x-agent-token':'model-token'},body:JSON.stringify({sessionId:'alpha'})});assert.equal(r.status,403);
 r=await fetch(base+'/api/socialV2/proactive-opportunity',{method:'POST',headers,body:JSON.stringify({sessionId:'alpha'})});assert.equal(r.status,403);
 r=await fetch(base+'/api/socialV2/proactive-opportunity',{method:'POST',headers,body:JSON.stringify({sessionId:'alpha',dryRun:true})});assert.equal(r.status,200);const result=await r.json();assert.equal(result.dryRun,true);assert.equal(result.accepted,false);
 assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.created.length,0);assert.equal(h.calls.sent.length,0);
});

test('report-only ingress is denied without whitelist',async t=>{
 const h=await fixture(t);h.cfg.deployment.reportGroups=['789'];await h.handleIncoming('group',789,event(80,'仅报告群'),h.cfg);const base=await server(t,h);const state=await(await fetch(base+'/api/deployment/status',{headers})).json();assert.equal(state.messages,0);assert.equal(h.calls.prompts.length,0);assert.equal(h.calls.created.length,0);assert.throws(()=>h.sendToQQ('group:789','禁止发送'),/白名单|allowed/);
});
test('operator voice rechecks deployment after asynchronous audio processing',async t=>{
 let h;h=await fixture(t,{inspectAudio:async()=>({ok:true}),processAudioVolume:async file=>{h.cfg.deployment.outgoingEnabled=false;return {path:file};}});h.cfg.deployment.outgoingEnabled=true;await assert.rejects(h.sendVoiceV2('group:456','fixture.mp3',{guard:false,audit:false}),/关闭|disabled/);assert.equal(h.calls.http.filter(r=>r.url.includes('send_')).length,0);
});
test('queued shared wake rechecks inference after session creation',async t=>{
 const h=await fixture(t);h.cfg.deployment.inferenceEnabled=true;h.cfg.deployment.outgoingEnabled=true;h.setReady(true);h.cfg.agentPreset='qq-chat';h.cfg.socialV2.agentPreset='qq-chat';h.setPresets(['qq-chat']);h.socialV2.paused=false;
 const create=h.api.sessions.create;h.api.sessions.create=async args=>{const result=await create(args);h.cfg.deployment.inferenceEnabled=false;return result;};
 await h.deliverPrompt('group:456','',{externalFactId:'00000000-0000-0000-0000-000000000000',silent:true});assert.equal(h.calls.created.length,1);assert.equal(h.calls.prompts.length,0);
});


async function activeFixture(t){
 let clock=Date.parse('2026-10-23T02:00:00Z'),runtime;
 const h=await fixture(t,{createDeploymentRuntime:args=>{runtime=createDeploymentRuntime({...args,now:()=>clock});return runtime;}});
 h.setMode('reserved2');h.cfg.deployment.inferenceEnabled=true;h.cfg.deployment.outgoingEnabled=true;h.cfg.deployment.proactive={enabled:true};
 h.cfg.agentPreset='qq-chat';h.cfg.socialV2.agentPreset='qq-chat';h.setPresets(['qq-chat']);h.setReady(true);h.socialV2.paused=false;
 return {h,runtime,advance(ms){clock+=ms;}};
}

test('autonomous dispatch shares cooldown but explicit replies remain available',async t=>{
 const {h,runtime}=await activeFixture(t);runtime.activity=()=>({lastIncomingAt:Date.now()-3*3600000,lastBotAt:0,messages15m:0,participants15m:0});
 await h.deliverPrompt('group:456','',{wakeReason:'timeout',silent:true});assert.equal(h.calls.prompts.length,1);
 await h.deliverPrompt('group:456','',{wakeReason:'proactiveCheck',silent:true});assert.equal(h.calls.prompts.length,1);
 await h.deliverPrompt('group:456','',{wakeReason:'replyCheck',silent:true});assert.equal(h.calls.prompts.length,1);
 for(const reason of ['atMention','nameMention'])await h.deliverPrompt('group:456','',{wakeReason:reason,silent:true});
 await h.deliverPrompt('private:123','',{wakeReason:'private',silent:true});assert.equal(h.calls.prompts.length,4);
 h.getSocialV2State('group:456').unread.push({seq:1,messageId:'777',sender:'fixture',userId:'123',text:'有新回复',time:Date.now()});
 await h.deliverPrompt('group:456','',{wakeReason:'replyCheck',silent:true});assert.equal(h.calls.prompts.length,5,'reply check with real unread does not spend proactive quota');
});

test('autonomous dispatch rechecks live gates after session creation',async t=>{
 const {h,runtime,advance}=await activeFixture(t);const create=h.api.sessions.create;
 h.api.sessions.create=async args=>{const result=await create(args);h.cfg.deployment.outgoingEnabled=false;return result;};
 await h.deliverPrompt('group:456','',{wakeReason:'timeout',silent:true});assert.equal(h.calls.prompts.length,0);
 h.cfg.deployment.outgoingEnabled=true;assert.equal(runtime.claimProactiveWake('group:456'),true,'revocation did not consume opportunity');
 advance(13*3600000);await h.deliverPrompt('group:456','',{wakeReason:'proactiveCheck',silent:true});assert.equal(h.calls.prompts.length,0);
 await h.deliverPrompt('group:456','',{wakeReason:'atMention',silent:true});assert.equal(h.calls.prompts.length,1,'direct reply allowed at night');
});

test('standalone scheduler ignores obsolete speak-up driver and rechecks local activity',async t=>{
 const {h,runtime}=await activeFixture(t);h.cfg.deployment.proactive.driver='speak-up';
 runtime.activity=()=>({lastIncomingAt:Date.now()-3*3600000,lastBotAt:0,messages15m:0,participants15m:0});
 await h.deliverPrompt('group:456','',{wakeReason:'timeout',silent:true});assert.equal(h.calls.prompts.length,1);
 await h.deliverPrompt('group:456','',{wakeReason:'proactiveCheck',silent:true});assert.equal(h.calls.prompts.length,1);
 runtime.activity=()=>({lastIncomingAt:Date.now()-1000,lastBotAt:0,messages15m:20,participants15m:4});
 await h.deliverPrompt('private:123','',{wakeReason:'proactiveCheck',silent:true});assert.equal(h.calls.prompts.length,1);
 assert.equal(runtime.claimProactiveWake('private:123'),true,'skipped local opportunity did not consume budget');
 await h.deliverPrompt('private:123','',{wakeReason:'atMention',silent:true});assert.equal(h.calls.prompts.length,2,'direct contact remains available');
});

test('deployment prompts keep protocol without upstream persona and search advice',async t=>{
 const {h}=await activeFixture(t);const prompt=h.buildWakePromptV2('group:456','proactiveCheck');
 for(const text of ['装傻','已读乱回','不要习惯性潜水','沉睡前强制等待','mcp__web-search-safe__web_search'])assert.ok(!prompt.includes(text),text);
 assert.ok(prompt.includes('原始柚子'));assert.ok(prompt.includes('qq_mark_read'));assert.ok(prompt.includes('会话令牌'));
 const base=await server(t,h);const r=await fetch(base+'/api/socialV2/prompt?key=group:456',{headers});const data=await r.json();
 assert.equal(data.role.name,null);assert.equal(data.recommended,null);assert.equal(data.participation,null);
});


test('already claimed cross-chat fact is not charged twice at dispatch',async t=>{
 const {h,runtime}=await activeFixture(t);h.cfg.allow.groups.push('789');
 runtime.ingest('group:456',{...event(201,'群里最近在聊面试'),time:Date.parse('2026-10-23T02:00:00Z')/1000});
 runtime.ingest('group:789',event(202,'明天参加面试'));
 const fact=runtime.remember({key:'group:789',messageId:'202',subjectId:'123',category:'plan',text:'明天参加面试',scope:'shared'});
 const wake=runtime.claimCrossChatWake();assert.equal(wake.factId,fact.id);
 assert.equal(runtime.claimProactiveWake('private:123'),true);assert.equal(runtime.claimProactiveWake('group:789'),true);
 await h.deliverPrompt(wake.key,'',{wakeReason:'sharedEvent',externalFactId:wake.factId,silent:true});
 assert.equal(h.calls.prompts.length,1);assert.equal(runtime.claimProactiveWake('group:456'),false);
});
