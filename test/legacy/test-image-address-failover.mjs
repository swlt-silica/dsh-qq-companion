import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import {EventEmitter} from 'node:events';
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001','hex');
async function harness(addresses,behavior,run){
 const previousLookup=dns.promises.lookup,previousRequest=https.request;const calls=[];
 dns.promises.lookup=async()=>addresses;
 https.request=(options,onResponse)=>{
  calls.push(options);const req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true;};
  req.end=()=>setImmediate(()=>{
   if(req.destroyed)return;const socket=new EventEmitter();socket.connecting=true;socket.authorized=false;req.emit('socket',socket);
   const action=behavior(options,calls.length);
   if(action==='fail'){req.emit('error',Object.assign(new Error('unreachable test node'),{code:'ENETUNREACH'}));return;}
   socket.connecting=false;socket.emit('connect');
   if(action==='tls-hang')return;
   socket.authorized=true;socket.emit('secureConnect');
   const res=new EventEmitter();res.statusCode=200;res.headers={};res.complete=false;res.destroyed=false;res.destroy=()=>{res.destroyed=true;};onResponse(res);
   const finish=()=>{if(req.destroyed||res.destroyed)return;res.emit('data',png);res.complete=true;res.emit('end');};
   if(action==='slow-body')setTimeout(finish,2900);else finish();
  });return req;
 };
 try{const module=await import('../../src/runtime/safe-fetch.js?image-failover='+Math.random());return await run(module,calls);}
 finally{dns.promises.lookup=previousLookup;https.request=previousRequest;}
}
test('QQ image download reaches a healthy third IPv4 after the first two fail and IPv6 is unavailable',async()=>{
 const addresses=[{address:'9.9.9.1',family:4},{address:'2606:4700::1111',family:6},{address:'9.9.9.2',family:4},{address:'2606:4700::1001',family:6},{address:'9.9.9.3',family:4}];
 await harness(addresses,o=>o.hostname==='9.9.9.3'?'ok':'fail',async({safeFetchBuffer},calls)=>{
  const result=await safeFetchBuffer('https://cdn.example/image.png');assert.deepEqual(result.buffer,png);assert.equal(calls.length,5);
  assert(calls.every(o=>o.servername==='cdn.example'&&o.headers.host==='cdn.example'&&o.rejectUnauthorized===true));
 });
});
test('image connection or TLS stall yields to another validated address promptly',async()=>{
 await harness([{address:'9.9.9.1',family:4},{address:'9.9.9.2',family:4}],o=>o.hostname==='9.9.9.1'?'tls-hang':'ok',async({safeFetchBuffer})=>{
  const started=Date.now();const result=await safeFetchBuffer('https://cdn.example/image.png');assert.deepEqual(result.buffer,png);assert(Date.now()-started<4500,'stalled TLS must not consume the previous 8 second per-address budget');
 });
});
test('a completed TLS handshake retains the normal response body budget',async()=>{
 await harness([{address:'9.9.9.1',family:4},{address:'9.9.9.2',family:4}],()=> 'slow-body',async({safeFetchBuffer},calls)=>{
  const result=await safeFetchBuffer('https://cdn.example/image.png');assert.deepEqual(result.buffer,png);assert.equal(calls.length,1);
 });
});
test('image fallback still rejects any private DNS answer before transport and does not retry oversized bodies',async()=>{
 await harness([{address:'9.9.9.1',family:4},{address:'127.0.0.1',family:4}],()=> 'ok',async({safeFetchBuffer},calls)=>{
  await assert.rejects(safeFetchBuffer('https://cdn.example/image.png'),/内网|本机/);assert.equal(calls.length,0);
 });
 await harness([{address:'9.9.9.1',family:4},{address:'9.9.9.2',family:4}],()=> 'ok',async({safeFetchBuffer},calls)=>{
  await assert.rejects(safeFetchBuffer('https://cdn.example/image.png',16),/大小限制/);assert.equal(calls.length,1);
 });
});
