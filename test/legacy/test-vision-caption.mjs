import test from 'node:test';import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createDeploymentRuntime} from '../../src/runtime/deployment-runtime.mjs';
import {createVisionCaptioner,captionImageResults} from '../../src/runtime/vision-caption.mjs';
test('text-only QQ main model receives a scoped visual description instead of unusable image blocks',async()=>{
 let runtime;const calls=[];const h=await bridgeHarness({config:{deployment:{inferenceEnabled:true,outgoingEnabled:true,vision:{enabled:true}}},globals:{createDeploymentRuntime:options=>(runtime=createDeploymentRuntime(options)),createVisionCaptioner:()=>({caption:async input=>{calls.push(input);return '白色背景上有一只橘猫，文字是你好。';},status:()=>({enabled:true})})}});
 try{const rows=await h.fetchMediaData([{kind:'image',file:'fixture.png'}],'group:456');assert.equal(rows.length,1);assert.equal(rows[0].data,undefined);assert.match(rows[0].text,/橘猫/);assert.equal(calls[0].scope,'group:456');assert.equal(h.calls.sent.length,0);assert.equal(h.calls.prompts.length,0);}finally{runtime?.close();await h.close();}
});
const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
function fixture(options={}){const requests=[];let authorized=true;const service=createVisionCaptioner({config:{baseURL:'https://vision.example/v1',model:'vision-test',apiKeyEnv:'TEST_VISION_KEY',timeoutMs:100,...options.config},env:{TEST_VISION_KEY:'fixture-secret'},canInfer:()=>authorized,fetchImpl:async(url,request)=>{requests.push({url,request});return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'图中是一只橘猫。'}}]})};},...options});return {service,requests,revoke(){authorized=false;}};}
test('visual captions use the dedicated model without tools and cache only within the same QQ source',async()=>{
 const f=fixture(),input={scope:'private:123',data,mimeType:'image/png'};const [a,b]=await Promise.all([f.service.caption(input),f.service.caption(input)]);assert.equal(a,b);assert.equal(f.requests.length,1);await f.service.caption(input);assert.equal(f.requests.length,1);await f.service.caption({...input,scope:'group:456'});assert.equal(f.requests.length,2);
 const body=JSON.parse(f.requests[0].request.body);assert.equal(body.model,'vision-test');assert.equal(body.tools,undefined);assert.equal(f.requests[0].request.redirect,'error');assert.equal(body.messages[1].content[1].image_url.url,'data:image/png;base64,'+data);
 f.revoke();await assert.rejects(f.service.caption(input),/不允许/);assert.equal(f.requests.length,2);
});
test('visual failures never return unusable image bytes or upstream secrets and do not retry',async()=>{
 const f=fixture({fetchImpl:async()=>{throw Error('secret https://private.example/?key=fixture-secret');}});
 const rows=await captionImageResults([{data,mimeType:'image/png'}],'private:123',f.service);assert.equal(rows[0].data,undefined);assert(!rows[0].text.includes('fixture-secret'));assert.match(rows[0].text,/暂时不可用/);assert.equal(f.service.status().calls,1);
});
test('visual requests are bounded even when a transport ignores abort',async()=>{
 const f=fixture({config:{baseURL:'https://vision.example/v1',model:'vision-test',apiKeyEnv:'TEST_VISION_KEY',timeoutMs:50},fetchImpl:()=>new Promise(()=>{})});await assert.rejects(f.service.caption({scope:'private:123',data,mimeType:'image/png'}),/超时/);assert.equal(f.service.status().pending,0);
});
test('invalid image, unscoped callers and insecure channels cannot invoke the visual provider',async()=>{
 const f=fixture();await assert.rejects(f.service.caption({scope:'private:123',data:'not base64',mimeType:'image/png'}),/格式/);await assert.rejects(f.service.caption({scope:'arbitrary',data,mimeType:'image/png'}),/不允许/);assert.equal(f.requests.length,0);assert.throws(()=>fixture({config:{baseURL:'http://vision.example',apiKeyEnv:'TEST_VISION_KEY',model:'test'}}),/HTTPS/);
});
