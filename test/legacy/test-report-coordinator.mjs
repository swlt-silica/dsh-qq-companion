import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const m=await import('../../src/runtime/report-coordinator.mjs').catch(()=>({}));
assert.equal(typeof m.createReportCoordinator,'function','report coordinator must exist');
assert.doesNotMatch(m.safeDshReportError({kind:'error',error:{code:'SERVER',message:'502 api_key="fixture-secret" Authorization: Bearer fixture-bearer sk-fixture-secret https://example.invalid/?token=private'}}),/fixture-secret|fixture-bearer|example.invalid|token=private/);
const dir=await mkdtemp(path.join(tmpdir(),'report-coordinator-'));
try {
 let enabled=false,outgoing=false,clock=new Date('2026-10-23T12:59:59Z'),generated=0,sends=0;
 const claims=new Set(),states=[];let queue=null;
 const runtime={status:()=>({inferenceEnabled:enabled,outgoingEnabled:outgoing}),isReportAllowed:g=>g==='fixture',claimReport:(g,d)=>{const key=g+d;if(claims.has(key))return false;claims.add(key);return true;},claimQueuedReport:()=>{const job=queue;queue=null;return job;},reportMessages:()=>[{id:'1',userId:'u',nickname:'甲',text:'测试',timestamp:Date.parse('2026-10-23T03:00:00Z')}],finishReport:(g,d,r)=>states.push(r)};
 const analysis={topics:[],user_titles:[],golden_quotes:[],chat_quality:{title:'质量',subtitle:'测试',summary:'测试',dimensions:[{name:'交流',percentage:100,comment:'测试',color:'#abcdef'}]}};
 runtime.reportStatistics=()=>({messages:10001,participants:500,characters:20002,hourly:Array.from({length:24},(_,i)=>i===11?10001:0)});
 const config={deployment:{reportsEnabled:true,reportGroups:['fixture','forbidden']}};
 const c=m.createReportCoordinator({runtime,config,generate:async()=>{generated++;return analysis;},outputDir:dir,sendReport:async()=>{sends++;},now:()=>clock});
 await c.tick();assert.equal(generated,0);
 enabled=true;await c.tick();assert.equal(generated,0);
 clock=new Date('2026-10-23T13:00:00Z');await Promise.all([c.tick(),c.tick()]);
 assert.equal(generated,1);assert.equal(sends,0);assert.equal(states.at(-1).status,'ready');
 assert.equal(states.at(-1).counts.messages,10001);assert.equal(states.at(-1).counts.truncated,true);
 await c.tick();assert.equal(generated,1,'claimed jobs cannot regenerate');
 outgoing=true;queue={groupId:'fixture',date:'2026-10-22'};
 const uncertain=m.createReportCoordinator({runtime,config,generate:async()=>analysis,outputDir:dir,sendReport:async()=>{assert.equal(states.at(-1).status,'sending');throw new Error('uncertain transport');},now:()=>clock});
 // Empty archive for requested old day fails generation and never sends.
 await uncertain.tick();assert.equal(states.at(-1).status,'failed');
 queue={groupId:'fixture',date:'2026-10-23'};
 const dir2=path.join(dir,'uncertain');
 const sendFailure=m.createReportCoordinator({runtime,config,generate:async()=>analysis,outputDir:dir2,sendReport:async()=>{assert.equal(states.at(-1).status,'sending');throw new Error('uncertain transport');},now:()=>clock});
 await sendFailure.tick();assert.equal(states.at(-1).status,'send-uncertain');
 // DSH event fixture: stream starts before prompt and completes only after prompt.
 let releaseSnapshot,releasePrompt,earlyPrompts=0;
 const snapshotReady=new Promise(resolve=>{releaseSnapshot=resolve;}),promptReady=new Promise(resolve=>{releasePrompt=resolve;});
 const readyResult=value=>({result:{ok:true,value}});
 const orderedApi={sessions:{create:async()=>readyResult({sessionId:'ordered'}),selectModel:async()=>readyResult({}),prompt:async()=>{earlyPrompts++;releasePrompt();return readyResult({});}},workspace:{archiveSession:async()=>readyResult({})},events:{mux:(_,signal)=>({follow(){},async *[Symbol.asyncIterator](){
  await snapshotReady;yield {payload:{type:'session/snapshot',sessionId:'ordered',snapshot:{}}};await promptReady;
  for(const event of [{type:'turn/start',data:{turn:'ordered-turn'}},{type:'assistant/message',data:{turn:'ordered-turn',message:{content:[{type:'text',text:'ready-before-prompt'}]}}},{type:'turn/end',data:{turn:'ordered-turn',reason:{kind:'completed'}}}])yield {payload:{type:'session/event',sessionId:'ordered',event}};
 }})}};
 const ordered=m.generateDshText({api:orderedApi,prompt:'fixture',provider:'p',model:'m',cwd:dir,timeoutMs:500});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(earlyPrompts,0,'do not prompt before session follow snapshot acknowledges subscription');releaseSnapshot();
 assert.equal(await ordered,'ready-before-prompt');assert.equal(earlyPrompts,1);
 const calls=[];let aborted=false,release;
 const ready=new Promise(resolve=>{release=resolve;});
 const ok=value=>({result:{ok:true,value}});
 const api={sessions:{create:async v=>{calls.push(['create',v]);return ok({sessionId:'fixture-session'});},selectModel:async v=>{calls.push(['model',v]);return ok({});},prompt:async v=>{calls.push(['prompt',v]);release();return ok({});}},workspace:{archiveSession:async()=>{calls.push(['archive']);return ok({});}},events:{mux:(_,signal)=>{signal.addEventListener('abort',()=>{aborted=true;});return {follow:s=>calls.push(['follow',s]),forget:()=>calls.push(['forget']),async *[Symbol.asyncIterator](){yield {payload:{type:'session/snapshot',sessionId:'fixture-session',snapshot:{}}};await ready;for(const event of [{type:'turn/start',data:{turn:'t'}},{type:'assistant/message',data:{turn:'t',message:{content:[{type:'text',text:'{"ok":true}'}]}}},{type:'turn/end',data:{turn:'t',reason:{kind:'completed'}}}])yield {payload:{type:'session/event',sessionId:'fixture-session',event}};}};}}};
 assert.equal(await m.generateDshText({api,prompt:'fixture',provider:'vulcan-guomo',model:'deepseek-v4.1-flash',cwd:dir}),'{"ok":true}');
 assert.ok(calls.findIndex(x=>x[0]==='model')<calls.findIndex(x=>x[0]==='prompt'));assert.equal(calls.filter(x=>x[0]==='prompt').length,1);assert.equal(calls[0][1].agentPreset,'qq-report');assert.ok(aborted);assert.ok(calls.some(x=>x[0]==='archive'));
 let releaseCreate,canInfer=true,revokedPrompts=0,revokedCleanup=0,revokedArchive=0;
 const createBlocked=new Promise(resolve=>{releaseCreate=resolve;});
 const revokedApi={...api,sessions:{...api.sessions,create:async()=>{await createBlocked;return ok({sessionId:'revoked-session'});},prompt:async()=>{revokedPrompts++;return ok({});}},stopSessionWork:async()=>{revokedCleanup++;},workspace:{archiveSession:async()=>{revokedArchive++;return ok({});}},events:{mux:(_,signal)=>({follow(){},async *[Symbol.asyncIterator](){yield {payload:{type:'session/snapshot',sessionId:'revoked-session',snapshot:{}}};await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}})}};
 const revoked=m.generateDshText({api:revokedApi,prompt:'fixture',provider:'p',model:'m',cwd:dir,timeoutMs:100,assertCanInfer:()=>{if(!canInfer)throw new Error('inference revoked');}});
 canInfer=false;releaseCreate();await assert.rejects(revoked,/inference revoked/);
 assert.equal(revokedPrompts,0);assert.equal(revokedCleanup,1);assert.equal(revokedArchive,1);
 // Captured event shape from the authorized synthetic Linux probe: the model
 // channel returned upstream 502, not a successful text turn or schema drift.
 api.events.mux=()=>({follow(){},async *[Symbol.asyncIterator](){
  yield {payload:{type:'session/snapshot',sessionId:'fixture-session',snapshot:{}}};await new Promise(resolve=>setTimeout(resolve,1));
  for(const event of [{type:'turn/start',data:{turn:'failed'}},{type:'turn/end',data:{turn:'failed',reason:{kind:'error',error:{message:'502: {"message":"Upstream service temporarily unavailable","type":"upstream_error"}',code:'SERVER'}}}}])yield {payload:{type:'session/event',sessionId:'fixture-session',event}};
 }});
 let failedStopped=0;api.stopSessionWork=async()=>{failedStopped++;};
 const promptsBefore=calls.filter(x=>x[0]==='prompt').length,archivesBefore=calls.filter(x=>x[0]==='archive').length;
 await assert.rejects(m.generateDshText({api,prompt:'x',provider:'p',model:'m',cwd:dir}),/SERVER.*502.*Upstream service temporarily unavailable/);
 assert.equal(calls.filter(x=>x[0]==='prompt').length-promptsBefore,1);assert.equal(failedStopped,1);assert.equal(calls.filter(x=>x[0]==='archive').length-archivesBefore,1);
 api.events.mux=(_,signal)=>({follow(){},async *[Symbol.asyncIterator](){yield {payload:{type:'stream/error',error:{code:'fixture'}}};}});
 await assert.rejects(m.generateDshText({api,prompt:'x',provider:'p',model:'m',cwd:dir}),/stream/i);
 api.events.mux=(_,signal)=>({follow(){},async *[Symbol.asyncIterator](){await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}});
 await assert.rejects(m.generateDshText({api,prompt:'x',provider:'p',model:'m',cwd:dir,timeoutMs:60}),/timeout/);
 console.log('report coordinator: passive gate, 21:00 durable claim, single active job, queued requests, no preview send, sending/uncertain states; DSH model order, one prompt, error/timeout cleanup PASS');
}finally{await rm(dir,{recursive:true,force:true});}
