import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeEnvironment} from '../src/host/environment.mjs';
test('only the configured vision credential is passed to worker, with explicit DSH home',()=>{
 const env=runtimeEnvironment({legacy:{deployment:{vision:{enabled:true,apiKeyEnv:'VISION_KEY'}}},dshHome:'/fixture',env:{VISION_KEY:'fixture-secret',OTHER_SECRET:'do-not-inherit'}});
 assert.equal(env.VISION_KEY,'fixture-secret');assert.equal(env.DSH_HOME,'/fixture');assert.equal(env.OTHER_SECRET,undefined);
 assert.throws(()=>runtimeEnvironment({legacy:{deployment:{vision:{enabled:true,apiKeyEnv:'VISION_KEY'}}},dshHome:'/fixture',env:{}}),/vision|视觉/);
});
