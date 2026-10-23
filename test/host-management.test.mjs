import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagementHandler} from '../src/host/management.mjs';
function response(){return {statusCode:200,headers:{},writeHead(n,h){this.statusCode=n;Object.assign(this.headers,h);},end(x){this.body=x;}};}
function fixture(){let called=0;const handler=createManagementHandler({authenticate:req=>req.headers.cookie==='fixture',snapshot:async()=>({revision:1}),dispatch:async(action,payload,revision)=>{called++;return {action,payload,revision};},diary:async date=>'# '+date});return {handler,get called(){return called;}};}
async function request(f,{method='GET',headers={},url='/api/qq-companion',body=''}={}){const res=response();const req={method,url,headers:{host:'localhost',...headers},async *[Symbol.asyncIterator](){yield Buffer.from(body);}};await f.handler(req,res);return res;}
test('management rejects anonymous and authenticated agent callers before any action',async()=>{
 const f=fixture();assert.equal((await request(f)).statusCode,401);assert.equal((await request(f,{headers:{cookie:'fixture','x-qq-agent-token':'any'}})).statusCode,403);assert.equal(f.called,0);
});
test('mutations require same-origin authenticated JSON; malformed or oversized body cannot dispatch',async()=>{
 const f=fixture();const body=JSON.stringify({action:'runtime.pause',payload:{},revision:1});
 for(const headers of [{cookie:'fixture',origin:'https://evil.invalid','content-type':'application/json'},{cookie:'fixture','content-type':'text/plain'},{cookie:'fixture','content-type':'application/json','sec-fetch-site':'cross-site'}])assert.equal((await request(f,{method:'POST',headers,body})).statusCode,403);
 assert.equal((await request(f,{method:'POST',headers:{cookie:'fixture','content-type':'application/json'},body:'{bad'})).statusCode,400);assert.equal(f.called,0);
 const res=await request(f,{method:'POST',headers:{cookie:'fixture',origin:'http://localhost','content-type':'application/json'},body});assert.equal(res.statusCode,200);assert.equal(f.called,1);
});
test('diary path traversal is rejected; valid download is private no-store Markdown',async()=>{
 const f=fixture();assert.equal((await request(f,{headers:{cookie:'fixture'},url:'/api/qq-companion?diary=../secret'})).statusCode,400);
 const r=await request(f,{headers:{cookie:'fixture'},url:'/api/qq-companion?diary=2026-10-22&download=1'});assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');assert.match(r.headers['content-disposition'],/2026-10-22/);assert.equal(r.body,'# 2026-10-22');
});
