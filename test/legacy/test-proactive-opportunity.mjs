import test from 'node:test';
import assert from 'node:assert/strict';
let evaluateOpportunity;
try { ({evaluateOpportunity}=await import('../../src/runtime/proactive-opportunity.mjs')); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }
test('controlled proactive opportunity policy exists',()=>assert.equal(typeof evaluateOpportunity,'function'));
const spec={skip:!evaluateOpportunity};
function fixture(){return {sessionId:'session-alpha',sessions:{'group:456':'alpha','private:123':'beta'},allowed:key=>['group:456','private:123'].includes(key),mode:'reserved2',paused:false,busy:false,inference:true,outgoing:true,budgetAvailable:true,activity:{lastIncomingAt:1000,lastBotAt:0,messages15m:0,participants15m:0},now:3601000,groupIdleMs:900000,privateIdleMs:3600000};}
test('unknown, ambiguous, non-allowed, inactive and busy targets fail closed',spec,()=>{
 const f=fixture();assert.equal(evaluateOpportunity(f).ok,true);
 for(const patch of [{sessionId:'other'},{sessions:{'group:456':'alpha','private:123':'session-alpha'}},{allowed:()=>false},{mode:'chat'},{paused:true},{busy:true}])assert.equal(evaluateOpportunity({...f,...patch}).ok,false);
});
test('deployment switches and durable budget gate real and manual opportunities',spec,()=>{
 const f=fixture();for(const patch of [{inference:false},{outgoing:false},{budgetAvailable:false}])assert.equal(evaluateOpportunity({...f,...patch}).ok,false);
});
test('local group activity and private idle messages use distinct clocks',spec,()=>{
 const f=fixture();assert.equal(evaluateOpportunity({...f,activity:{...f.activity,lastIncomingAt:f.now-1000}}).ok,false);
 assert.equal(evaluateOpportunity({...f,activity:{...f.activity,messages15m:15,participants15m:4}}).ok,false);
 const p={...f,sessionId:'beta'};assert.equal(evaluateOpportunity(p).ok,true);
 assert.equal(evaluateOpportunity({...p,activity:{...p.activity,lastBotAt:p.now-5000}}).ok,true,'ordinary private replies do not consume an unsolicited opportunity');
 assert.equal(evaluateOpportunity({...p,budgetAvailable:false,activity:{...p.activity,lastBotAt:p.now-5000}}).ok,false,'durable unsolicited claim prevents chasing without a new human message');
});
test('dry run returns the same eligibility without invoking any external work',spec,()=>{
 const f=fixture();assert.deepEqual(evaluateOpportunity({...f,dryRun:true}),evaluateOpportunity(f));
 assert.equal(evaluateOpportunity({...f,activity:{...f.activity,lastIncomingAt:0}}).ok,false,'no history is not a cold-chat invitation');
});
