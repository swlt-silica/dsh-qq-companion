// MIT. Small OneBot v11 transport; no QQ client implementation is bundled.
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

export const text=value=>({type:'text',data:{text:String(value)}});
const chain=value=>typeof value==='string'?[text(value)]:Array.isArray(value)?value:[value];
function fault(code,message){return Object.assign(new Error(message),{code});}

export class SnowLumaWebSocketClient extends EventEmitter {
 constructor({url='ws://127.0.0.1:3001',accessToken,requestTimeoutMs=30000,reconnect=true}={}){
  super();const parsed=new URL(url);if(!['ws:','wss:'].includes(parsed.protocol)||parsed.username||parsed.password)throw fault('ONEBOT_CONFIG','Invalid OneBot WebSocket URL');
  this.url=url;this.accessToken=accessToken;this.requestTimeoutMs=requestTimeoutMs;this.reconnect=reconnect;this.pending=new Map();this.socket=null;this.closed=true;this.attempt=0;
  this.on('error',()=>{});
 }
 get isConnected(){return this.socket?.readyState===WebSocket.OPEN;}
 connect(){
  if(this.isConnected)return Promise.resolve();if(this.connecting)return this.connecting;
  this.closed=false;clearTimeout(this.retryTimer);
  const socket=new WebSocket(this.url,{headers:this.accessToken?{Authorization:`Bearer ${this.accessToken}`}:{},handshakeTimeout:10000,maxPayload:16*1024*1024});this.socket=socket;
  this.connecting=new Promise((resolve,reject)=>{
   let opened=false;
   socket.on('open',()=>{opened=true;this.attempt=0;this.connecting=null;this.emit('open');resolve();});
   socket.on('error',()=>{this.emit('error',fault('ONEBOT_CONNECTION','OneBot connection failed'));});
   socket.on('message',raw=>{try{this.accept(JSON.parse(raw.toString('utf8')));}catch(error){this.emit('error',fault('ONEBOT_PACKET','Invalid OneBot packet'));}});
   socket.on('close',(code)=>{
    if(this.socket!==socket)return;
    this.socket=null;this.connecting=null;
    if(!opened)reject(fault('ONEBOT_CONNECTION','OneBot connection closed before opening'));
    this.rejectPending();this.emit('close',{code});
    if(this.reconnect&&!this.closed){this.retryTimer=setTimeout(()=>{this.connect().catch(()=>{});},Math.min(30000,1000*2**Math.min(this.attempt++,5)));this.retryTimer.unref?.();}
   });
  });return this.connecting;
 }
 accept(packet){
  if(!packet||typeof packet!=='object'||Array.isArray(packet))throw fault('ONEBOT_PACKET','Invalid OneBot packet');
  if(Object.hasOwn(packet,'echo')){const pending=this.pending.get(String(packet.echo));if(pending){pending.finish();pending.resolve(packet);}return;}
  this.emit('event',packet);
  if(['message','message_sent'].includes(packet.post_type)){
   this.emit('message',packet);if(packet.message_type==='group')this.emit('group-message',packet);if(packet.message_type==='private')this.emit('private-message',packet);
  }else if(packet.post_type==='notice'){this.emit('notice',packet);this.emit('notice:'+packet.notice_type,packet);}
  if(packet.meta_event_type==='bot_status'||packet.notice_type==='bot_status'||packet.post_type==='bot_status')this.emit('bot-status',packet);
 }
 rejectPending(){for(const pending of [...this.pending.values()]){pending.finish();pending.reject(fault('ONEBOT_UNCERTAIN','OneBot connection closed; delivery is unconfirmed'));}}
 close(code=1000,reason='normal'){
  this.closed=true;clearTimeout(this.retryTimer);this.rejectPending();
  const socket=this.socket;this.socket=null;this.connecting=null;
  if(socket){if(socket.readyState===WebSocket.OPEN)socket.close(code,reason);else socket.terminate();}
 }
 async request(action,params={},options={}){
  options.signal?.throwIfAborted();await this.connect();options.signal?.throwIfAborted();
  const socket=this.socket;if(!this.isConnected)throw fault('ONEBOT_CONNECTION','OneBot is not connected');
  const echo=randomUUID();return new Promise((resolve,reject)=>{
   const abort=()=>{finish();reject(fault('ONEBOT_UNCERTAIN','OneBot request aborted; delivery is unconfirmed'));};
   const timer=setTimeout(()=>{finish();reject(fault('ONEBOT_UNCERTAIN','OneBot request timed out; delivery is unconfirmed'));},options.timeoutMs??this.requestTimeoutMs);
   const finish=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);this.pending.delete(echo);};
   this.pending.set(echo,{resolve,reject,finish});options.signal?.addEventListener('abort',abort,{once:true});
   try{socket.send(JSON.stringify({action,params,echo}),error=>{if(error){finish();reject(fault('ONEBOT_UNCERTAIN','OneBot transport failed; delivery is unconfirmed'));}});}catch{finish();reject(fault('ONEBOT_UNCERTAIN','OneBot transport failed; delivery is unconfirmed'));}
  });
 }
 async raw(action,params={},options){const r=await this.request(action,params,options);if(r.status!=='ok'||Number(r.retcode)!==0)throw Object.assign(fault('ONEBOT_REJECTED',String(r.message??r.wording??'OneBot rejected request').slice(0,300)),{retcode:r.retcode});return r.data;}
 call(action,params,options){return this.raw(action,params,options);}
 sendPrivateMessage(id,message,options){return this.raw('send_private_msg',{user_id:id,message:chain(message),auto_escape:options?.autoEscape},options);}
 sendGroupMessage(id,message,options){return this.raw('send_group_msg',{group_id:id,message:chain(message),auto_escape:options?.autoEscape},options);}
 getMessage(id,options){return this.raw('get_msg',{message_id:id},options);}
 getLoginInfo(options){return this.raw('get_login_info',{},options);}
 getStatus(options){return this.raw('get_status',{},options);}
 getImage(params,options){return this.raw('get_image',params,options);}
 getGroupMemberList(id,options){return this.raw('get_group_member_list',{group_id:id},options);}
 getGroupMemberInfo(group,user,options){return this.raw('get_group_member_info',{group_id:group,user_id:user},options);}
 fetchFaceEntity(id,options){return this.raw('fetch_face_entity',{face_id:id,refresh:options?.refresh??false},options);}
 subscribe(name,fn){const safe=(...args)=>{try{Promise.resolve(fn(...args)).catch(error=>this.emit('error',error));}catch(error){this.emit('error',error);}};this.on(name,safe);return()=>this.off(name,safe);}
 onEvent(fn){return this.subscribe('event',fn);}
 onPrivateMessage(fn){return this.subscribe('private-message',fn);}
 onGroupMessage(fn){return this.subscribe('group-message',fn);}
 onNotice(type,fn){return typeof type==='function'?this.subscribe('notice',type):this.subscribe('notice:'+type,fn);}
 onBotStatus(fn){return this.subscribe('bot-status',fn);}
}
