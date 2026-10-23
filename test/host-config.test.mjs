import test from 'node:test';
import assert from 'node:assert/strict';
import {initialFromLegacy,toRuntimeConfig} from '../src/host/config-mapper.mjs';
test('migration preserves model/persona/vision and only changes approved runtime fields',()=>{
 const old={ownerQQ:'11',allow:{groups:['22'],private:['11']},dsh:{model:'deepseek-v4-pro-0813',provider:'fixture'},socialV2:{media:{maxGifFrames:3},systemPrompt:'complete persona'},consoleToken:'secret-secret-secret',deployment:{reportGroups:['33'],memory:{limit:6}}};
 const c=initialFromLegacy(old,{stateDir:'/data/state',workspace:'/data/workspace',dshHome:'/data/dsh'});assert.deepEqual(c.access.groups,['22']);assert.deepEqual(c.reports.groups,[]);
 c.access.groups.push('44');const result=toRuntimeConfig(c,old);assert.equal(result.dsh.model,old.dsh.model);assert.equal(result.socialV2.systemPrompt,'complete persona');assert.equal(result.socialV2.media.maxGifFrames,3);assert.deepEqual(result.allow.groups,['22','44']);assert.equal(result.deployment.memory.limit,6);assert.equal(result.allowAllWhenEmpty,false);assert.equal(result.deployment.proactive.dailyLimit,10);assert.equal(result.deployment.proactive.cooldownMs,1800000);
});
test('disabled config closes both gates without erasing selected values',()=>{
 const c=initialFromLegacy({},{});c.runtime.enabled=false;const result=toRuntimeConfig(c,{});assert.equal(result.deployment.inferenceEnabled,false);assert.equal(result.deployment.outgoingEnabled,false);assert.equal(result.slang.enabled,false);
});
