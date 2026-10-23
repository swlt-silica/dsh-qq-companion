import test from 'node:test';
import assert from 'node:assert/strict';
import {installToolBridge} from '../src/host/tools.mjs';
test('tool bridge exposes only controlled QQ names in stable order and denies non-QQ execution',async()=>{
 const definitions=[];let invoked=0;
 const client={listTools:async()=>({tools:[{name:'exec',inputSchema:{}},{name:'qq_diary',description:'diary',inputSchema:{type:'object'}},{name:'qq_send_message',description:'send',inputSchema:{type:'object'}}]}),callTool:async()=>{invoked++;return {content:[{type:'text',text:'ok'}]};}};
 const dispose=await installToolBridge({tools:{register:d=>{definitions.push(d);return()=>{};}}},{client});
 assert.deepEqual(definitions.map(d=>d.name),['mcp__snowluma__qq_diary','mcp__snowluma__qq_send_message']);
 const execute=definitions[0].execute;
 await assert.rejects(execute({},{agent:{session:{header:{agentPreset:'standard'}}}}),/QQ/);assert.equal(invoked,0);
 assert.equal((await execute({},{agent:{session:{header:{agentPreset:'qq-yuzu'}}},signal:new AbortController().signal})).content[0].text,'ok');assert.equal(invoked,1);await dispose();
});
