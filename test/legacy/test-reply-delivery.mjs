import test from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createDeploymentRuntime} from '../../src/runtime/deployment-runtime.mjs';
async function fixture(t,effort='default'){
 const runtimes=[];
 const h=await bridgeHarness({config:{dsh:{reasoningEffort:effort},deployment:{outgoingEnabled:false,inferenceEnabled:false,lockMode:true}},files:{'state/mode.json':{mode:'reserved2'}},globals:{createDeploymentRuntime:args=>{const r=createDeploymentRuntime(args);runtimes.push(r);return r;}}});
 t.after(async()=>{runtimes.forEach(r=>r.close());await h.close();});
 h.setMode('reserved2');h.setReady(true);h.cfg.agentPreset='qq-chat';h.cfg.socialV2.agentPreset='qq-chat';h.setPresets(['qq-chat']);
 return h;
}
test('model default omits an unsupported explicit reasoning level',async t=>{
 const h=await fixture(t);let selection,count=0;
 h.api.sessions.selectModel=async args=>{selection=args;count++;return {result:{ok:true,value:{selected:{provider:args.provider,model:args.model}}}};};
 await h.ensureSession('private:123');await h.ensureSession('private:123');assert.ok(selection);assert.equal(Object.hasOwn(selection,'reasoningEffort'),false);assert.equal(count,1,'Successful selection is cached rather than retried');
});
test('explicit reasoning level is preserved when selected by administrator',async t=>{
 const h=await fixture(t,'high');let selection;
 h.api.sessions.selectModel=async args=>{selection=args;return {result:{ok:true,value:{selected:{provider:args.provider,model:args.model,reasoningEffort:'high'}}}};};
 await h.ensureSession('private:123');assert.equal(selection.reasoningEffort,'high');
});
test('wake reminder repairs unsent speech before acknowledging the read watermark',async t=>{
 const h=await fixture(t);const reminder=h.buildWakeReminderPromptV2('private:123');
 assert.match(reminder,/qq_social_state/);assert.match(reminder,/qq_send_message/);
 assert.match(reminder,/尚未发送成功/);assert.match(reminder,/不要重复发送/);
 assert.doesNotMatch(reminder,/请仅按实际已读消息/);
 assert.equal(h.calls.sent.length,0,'A reminder must not automatically forward internal text');
});
