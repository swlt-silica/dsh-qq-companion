import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDeploymentRuntime} from '../src/runtime/deployment-runtime.mjs';
import {evaluateOpportunity} from '../src/runtime/proactive-opportunity.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-policy-'));
 const config={ownerQQ:'123',selfQQ:'999',allow:{groups:['456','789'],private:['123','321']},deny:{groups:[],private:[]},deployment:{inferenceEnabled:true,outgoingEnabled:true,memberBoundaries:{enabled:true},reportGroups:['888'],proactive:{enabled:true,dailyLimit:10,cooldownMs:1800000,quietStart:'23:00',quietEnd:'08:00',timezone:'Asia/Shanghai'}}};
 let clock=Date.parse('2026-10-23T10:00:00+08:00'),runtime=createDeploymentRuntime({stateDir:dir,config,now:()=>clock});
 t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {config,get runtime(){return runtime;},advance(ms){clock+=ms;},reopen(){runtime.close();runtime=createDeploymentRuntime({stateDir:dir,config,now:()=>clock});},event:(id,userId='321')=>({message_id:id,user_id:userId,self_id:'999',time:Math.floor(clock/1000),message:[{type:'text',data:{text:'hello'}}]})};
}
test('report-only groups cannot archive, generate or send reports',t=>{const f=fixture(t);assert.equal(f.runtime.isReportAllowed('888'),false);assert.equal(f.runtime.ingest('group:888',f.event(1)).accepted,false);assert.throws(()=>f.runtime.reportMessages('888','2026-10-23'));});
test('one persistent budget permits ten dispatches and enforces thirty minutes per source',t=>{const f=fixture(t);for(let i=0;i<10;i++){assert.equal(f.runtime.claimProactiveWake('group:456'),true);assert.equal(f.runtime.claimProactiveWake('group:456'),false);f.advance(1800000);}f.reopen();assert.equal(f.runtime.claimProactiveWake('group:789'),false);});
test('private unsolicited wake cannot chase again until a new human message',t=>{const f=fixture(t);f.runtime.ingest('private:321',f.event(1));assert.equal(f.runtime.claimProactiveWake('private:321'),true);f.advance(1800000);f.reopen();assert.equal(f.runtime.claimProactiveWake('private:321'),false);f.runtime.ingest('private:321',f.event(2));assert.equal(f.runtime.claimProactiveWake('private:321'),true);});

test('ordinary private reply permits the first idle greeting; durable claim prevents chasing across restart',t=>{
 const f=fixture(t),key='private:321';
 f.runtime.ingest(key,f.event(11));f.advance(16000);f.runtime.ingest(key,f.event(12,'999'));f.advance(2*3600000);
 const eligible=()=>evaluateOpportunity({sessionId:'owner',sessions:{[key]:'owner'},allowed:k=>f.runtime.isAllowed(k),mode:'reserved2',paused:false,busy:false,inference:true,outgoing:true,budgetAvailable:f.runtime.proactiveBudgetAvailable(key),activity:f.runtime.activity(key),now:Date.parse('2026-10-23T12:00:16+08:00')});
 assert.equal(eligible().ok,true,'normal reply must not count as unsolicited greeting');
 assert.equal(f.runtime.claimProactiveWake(key),true);f.reopen();assert.equal(eligible().ok,false,'dispatch claim survives restart even if no greeting was sent');
 f.advance(3600000);f.runtime.ingest(key,f.event(13));f.advance(2*3600000);
 const activity=f.runtime.activity(key);assert.equal(evaluateOpportunity({sessionId:'owner',sessions:{[key]:'owner'},allowed:k=>f.runtime.isAllowed(k),mode:'reserved2',paused:false,busy:false,inference:true,outgoing:true,budgetAvailable:f.runtime.proactiveBudgetAvailable(key),activity,now:activity.lastIncomingAt+2*3600000}).ok,true);
});
test('manual blacklist is the actual persistent inbound database and protects owner/self',t=>{const f=fixture(t);assert.throws(()=>f.runtime.addIgnoredMember({subjectId:'123'}));assert.throws(()=>f.runtime.addIgnoredMember({subjectId:'999'}));f.runtime.addIgnoredMember({subjectId:'321'});assert.equal(f.runtime.ingest('group:456',f.event(1)).reason,'ignored');f.reopen();assert.equal(f.runtime.listIgnoredMembers()[0].subjectId,'321');f.runtime.releaseIgnoredMember({subjectId:'321'});assert.equal(f.runtime.isIgnored('321'),false);});
test('quiet window and per-source overrides are checked at dispatch',t=>{const f=fixture(t);f.config.deployment.proactive.quietStart='09:00';f.config.deployment.proactive.quietEnd='11:00';assert.equal(f.runtime.claimProactiveWake('group:456'),false);f.config.deployment.proactive.quietStart='23:00';f.config.deployment.proactive.quietEnd='08:00';f.config.deployment.proactive.overrides={'group:456':{enabled:false}};assert.equal(f.runtime.claimProactiveWake('group:456'),false);assert.equal(f.runtime.claimProactiveWake('group:789'),true);});
test('manual blacklist records reason and source without changing existing business schema',t=>{const f=fixture(t);f.runtime.addIgnoredMember({subjectId:'321',reason:'manual test'});f.reopen();const entry=f.runtime.listIgnoredMembers()[0];assert.equal(entry.reason,'manual test');assert.equal(entry.source,'manual');assert.equal(typeof entry.updatedAt,'number');f.config.deployment.memberBoundaries.enabled=false;assert.equal(f.runtime.ingest('group:456',f.event(99)).reason,'ignored');});
test('captured policy generation cannot send after remove/re-add',t=>{const f=fixture(t);assert.equal(typeof f.runtime.capturePolicyGuard,'function');const guard=f.runtime.capturePolicyGuard();f.runtime.revokePolicy();assert.throws(guard,/revoked/);});
test('source quiet overrides and target daily caps cannot exceed the shared budget',t=>{const f=fixture(t);f.config.deployment.proactive.overrides={'group:456':{quietStart:'09:00',quietEnd:'11:00'},'group:789':{dailyLimit:1}};assert.equal(f.runtime.claimProactiveWake('group:456'),false);assert.equal(f.runtime.claimProactiveWake('group:789'),true);f.advance(1800000);assert.equal(f.runtime.claimProactiveWake('group:789'),false);});
