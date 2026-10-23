import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {SnowLumaWebSocketClient,text} from '../src/host/onebot-client.mjs';

async function fixture(t,handle){
 const wss=new WebSocketServer({port:0,host:'127.0.0.1'});await once(wss,'listening');
 let socket;wss.on('connection',(ws,req)=>{socket=ws;ws.on('message',raw=>handle(ws,JSON.parse(raw),req));});
 const client=new SnowLumaWebSocketClient({url:`ws://127.0.0.1:${wss.address().port}`,accessToken:'fixture-secret',requestTimeoutMs:100,reconnect:false});
 t.after(async()=>{client.close();wss.clients.forEach(ws=>ws.terminate());await new Promise(r=>wss.close(r));});
 await client.connect();return {client,get socket(){return socket;}};
}
test('OneBot correlates concurrent replies and normalizes text without exposing token in query',async t=>{
 const pending=[];const f=await fixture(t,(ws,request,req)=>{assert.equal(req.url,'/');assert.equal(req.headers.authorization,'Bearer fixture-secret');pending.push(request);if(pending.length===2)for(const r of pending.reverse())ws.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data:{message_id:r.params.user_id??r.params.group_id}}));});
 const [a,b]=await Promise.all([f.client.sendPrivateMessage(12,text('a')),f.client.sendGroupMessage(34,[text('b')])]);
 assert.equal(a.message_id,12);assert.equal(b.message_id,34);assert.equal(pending[0].params.message[0].data.text,'b');
});
test('OneBot events include message_sent and heartbeat with no invented incoming user',async t=>{
 const f=await fixture(t,()=>{});const group=once(f.client,'group-message');const all=once(f.client,'event');
 f.socket.send(JSON.stringify({post_type:'message_sent',message_type:'group',group_id:1,user_id:2,self_id:2,message_id:3,message:[text('hello')]}));
 assert.equal((await group)[0].post_type,'message_sent');assert.equal((await all)[0].user_id,2);
});
test('uncertain send times out exactly once; failed envelope throws and does not reconnect/resend',async t=>{
 let count=0;const f=await fixture(t,(ws,r)=>{count++;if(r.action==='get_status')ws.send(JSON.stringify({echo:r.echo,status:'failed',retcode:1400,message:'rejected'}));});
 await assert.rejects(f.client.sendPrivateMessage(12,text('once')),{code:'ONEBOT_UNCERTAIN'});assert.equal(count,1);
 await assert.rejects(f.client.getStatus(),{code:'ONEBOT_REJECTED'});assert.equal(count,2);
});
test('closing rejects pending calls and deliberate close never auto reconnects',async t=>{
 let count=0;const f=await fixture(t,()=>{count++;});
 const waiting=f.client.getLoginInfo();await new Promise(r=>setTimeout(r,15));f.client.close();
 await assert.rejects(waiting,{code:'ONEBOT_UNCERTAIN'});assert.equal(count,1);assert.equal(f.client.isConnected,false);
});
