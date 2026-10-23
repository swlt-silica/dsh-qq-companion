import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {DatabaseSync} from 'node:sqlite';
import {createSupervisor} from '../src/host/supervisor.mjs';
import {installToolBridge} from '../src/host/tools.mjs';
async function waitFor(fn){for(let i=0;i<60;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw Error('fixture condition timed out');}
test('standalone bundled worker boots against fake gateway, honors ignore/blacklist and preserves state on shutdown',{timeout:15000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-integration-'));const actions=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;actions.push(req.url);res.writeHead(401,{'content-type':'application/json'});res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,wss=new WebSocketServer({server});let socket;
 wss.on('connection',ws=>{socket=ws;ws.on('message',raw=>{const r=JSON.parse(raw);actions.push(r.action);ws.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_login_info'?{user_id:12,nickname:'Fixture'}:{online:true,good:true}}));});});
 const free=http.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const consolePort=free.address().port;await new Promise(r=>free.close(r));
 const cfg={ownerQQ:'11',selfQQ:'12',agentPreset:'qq-yuzu',dsh:{baseUrl:`http://127.0.0.1:${port}`,authToken:'fixture-token-fixture',authTokenExplicit:true,provider:'fixture',model:'fixture',reasoningEffort:'default'},snowluma:{wsUrl:`ws://127.0.0.1:${port}`,httpUrl:`http://127.0.0.1:${port}`,followDiscoveredEndpoint:false},allow:{groups:['22'],private:['11']},consolePort,consoleToken:'fixture-console-token-fixture',slang:{enabled:false},socialV2:{enabled:true,sticker:{enabled:false}},deployment:{inferenceEnabled:false,outgoingEnabled:false,reportsEnabled:false,memberBoundaries:{enabled:true},dailyLearning:{enabled:false},proactive:{enabled:false}}};
 const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(cfg));
 const supervisor=createSupervisor({worker:fileURLToPath(new URL('../src/runtime/worker.mjs',import.meta.url)),stateDir:dir,configFile:file,root:dir,env:{DSH_HOME:dir},startTimeout:8000,maxRestarts:0});
 let db;
 t.after(async()=>{await supervisor.stop();db?.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 try{await supervisor.start();}catch(error){throw Error(error.message+'\n'+fs.readFileSync(path.join(dir,'companion-runtime.log'),'utf8'));}
 await waitFor(()=>socket);await supervisor.request('resume');
 socket.send(JSON.stringify({post_type:'message',message_type:'group',group_id:33,user_id:44,self_id:12,message_id:1,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'must be ignored'}}]}));
 socket.send(JSON.stringify({post_type:'message',message_type:'group',group_id:22,user_id:44,self_id:12,message_id:2,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'allowed archive'}}]}));
 db=new DatabaseSync(path.join(dir,'qq-runtime.sqlite'),{readOnly:true});await waitFor(()=>db.prepare('SELECT count(*) AS n FROM qq_messages WHERE id=?').get('2').n===1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM qq_messages WHERE key=?').get('group:33').n,0);
 await supervisor.request('blacklist.add',{userId:'44',reason:'fixture'});
 socket.send(JSON.stringify({post_type:'message',message_type:'group',group_id:22,user_id:44,self_id:12,message_id:3,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'ignored author'}}]}));
 await new Promise(r=>setTimeout(r,100));assert.equal(db.prepare('SELECT count(*) AS n FROM qq_messages WHERE id=?').get('3').n,0);
 assert.equal((await supervisor.request('blacklist.list'))[0].subjectId,'44');
 assert(!actions.some(x=>/^send_|session\/prompt/.test(x)),JSON.stringify(actions));
 await supervisor.stop();assert.equal(db.prepare('SELECT count(*) AS n FROM qq_messages').get().n,1);
});
test('standalone tool transport provides exactly36 controlled QQ schemas without legacy service',{timeout:10000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-tool-integration-'));fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({deployment:{},allow:{groups:[],private:[]}}));const defs=[];
 const dispose=await installToolBridge({tools:{register:d=>{defs.push(d);return()=>{};}}},{entry:fileURLToPath(new URL('../src/runtime/mcp-snowluma-safe.js',import.meta.url)),env:{PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',QQ_COMPANION_ROOT:dir,QQ_COMPANION_CONFIG_FILE:path.join(dir,'config.json'),QQ_COMPANION_STATE_DIR:dir,DSH_HOME:dir}});
 t.after(async()=>{await dispose();fs.rmSync(dir,{recursive:true,force:true});});assert.equal(defs.length,36);assert(!defs.some(d=>/exec|bash|shell|delete|upload|admin/.test(d.name)));
});
