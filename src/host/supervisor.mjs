import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Requests are never replayed after a timeout or child exit, including sends.
export function createSupervisor({worker,stateDir,configFile,root=path.dirname(configFile),env={},requestTimeout=15000,startTimeout=60000,maxRestarts=3,onState=()=>{}}){
 fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const lock=path.join(stateDir,'companion-host.lock'),nonce=randomUUID(),pending=new Map();
 let child=null,starting=null,stopping=null,accepting=false,desired=false,restarts=0,retryTimer,ownsLock=false,lastError=null,live={};
 const status=()=>({running:!!child,accepting,pid:child?.pid??null,restarts,lastError,...live});
 function notify(){onState(status());}
 function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
 function acquire(){
  if(ownsLock)return;
  for(let i=0;i<2;i++){
   try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});ownsLock=true;return;}
   catch(error){if(error.code!=='EEXIST')throw error;let old;try{old=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw Error('Invalid companion ownership lock; review before startup');}if(alive(old.pid))throw Error('Companion state already has an active owner');fs.unlinkSync(lock);}
  }throw Error('Companion ownership lock unavailable');
 }
 function release(){if(!ownsLock)return;try{const value=JSON.parse(fs.readFileSync(lock,'utf8'));if(value.nonce===nonce)fs.unlinkSync(lock);}catch{}ownsLock=false;}
 function settleAll(error){for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();}
 function safeEnv(){
  const result={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL','REPORT_PYTHON','PYTHONPATH','FFMPEG_PATH'])if(process.env[key]!==undefined)result[key]=process.env[key];
  return {...result,...env,QQ_COMPANION_ROOT:root,QQ_COMPANION_STATE_DIR:stateDir,QQ_COMPANION_CONFIG_FILE:configFile};
 }
 async function start(){
  desired=true;if(stopping)await stopping;if(child&&accepting)return status();if(starting)return starting;
  acquire();lastError=null;
  starting=new Promise((resolve,reject)=>{
   let ready=false;const timer=setTimeout(()=>{lastError='Runtime startup timed out';reject(Error(lastError));child?.kill('SIGTERM');},startTimeout);
   try{child=fork(worker,[],{env:safeEnv(),stdio:['ignore','pipe','pipe','ipc'],serialization:'json'});}catch(error){clearTimeout(timer);release();throw error;}
   // Child logs may contain private operational details; never forward to WebUI.
   const log=fs.createWriteStream(path.join(stateDir,'companion-runtime.log'),{flags:'a',mode:0o600});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
   child.on('message',message=>{
    if(message?.event==='ready'){ready=true;accepting=true;live=message.value??{};clearTimeout(timer);resolve(status());notify();}
    else if(message?.event==='status'){live=message.value??{};notify();}
    else if(message?.id&&pending.has(message.id)){const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timer);message.ok?p.resolve(message.value):p.reject(Object.assign(Error(message.error?.message??message.error??'Runtime operation failed'),{code:message.error?.code}));}
   });
   child.on('error',()=>{lastError='Runtime process failed';});
   child.once('exit',(code,signal)=>{
    clearTimeout(timer);log.end();child=null;accepting=false;live={};const error=Error(`Runtime exited (${code??signal})`);settleAll(error);if(!ready)reject(error);starting=null;
    if(desired&&restarts<maxRestarts){restarts++;retryTimer=setTimeout(()=>start().catch(()=>{}),Math.min(30000,1000*2**restarts));retryTimer.unref?.();}else if(!desired||maxRestarts===0)release();
    notify();
   });
  });
  try{return await starting;}catch(error){lastError=error.message;throw error;}finally{if(accepting)starting=null;}
 }
 function request(op,payload={},timeout=requestTimeout){
  if(!child?.connected||(!accepting&&op!=='shutdown'&&op!=='pause'))return Promise.reject(Error('Runtime is stopped or disabled'));
  const id=randomUUID();return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('Runtime operation timed out; it will not be retried'));},timeout);
   pending.set(id,{resolve,reject,timer});child.send({id,op,payload},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(Error('Runtime IPC failed; operation will not be retried'));}});
  });
 }
 function stop(){
  desired=false;accepting=false;clearTimeout(retryTimer);notify();if(stopping)return stopping;
  if(!child){release();return Promise.resolve();}
  stopping=(async()=>{
   const current=child;const exited=new Promise(resolve=>current.once('exit',resolve));
   // Worker handles shutdown by closing its outgoing gate synchronously first.
   try{await request('shutdown',{},3000);}catch{}
   if(child===current){current.kill('SIGTERM');const killTimer=setTimeout(()=>current.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(killTimer);}}
   settleAll(Error('Runtime stopped'));release();
  })().finally(()=>{stopping=null;});return stopping;
 }
 return {start,stop,request,status};
}
