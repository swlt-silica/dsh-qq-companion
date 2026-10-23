import test from 'node:test';import assert from 'node:assert/strict';
import {deploymentWakeText} from '../src/runtime/wake-prompt.mjs';
test('optimized wake preserves dynamic identity/source/token/reason and removes only duplicated protocol',()=>{
 const args={key:'group:20001',identity:'nickname fixture QQ12',token:'fixture-token',reason:'atMention',opportunity:false};
 const before=deploymentWakeText({...args,optimized:false}),after=deploymentWakeText({...args,optimized:true});
 for(const value of [args.key,args.identity,args.token,args.reason])assert(after.includes(value));
 assert(after.length<before.length*0.65);assert.match(after,/工具发送|发送工具/);assert.match(after,/水位/);assert.match(deploymentWakeText({...args,optimized:true,opportunity:true}),/安静/);
});
