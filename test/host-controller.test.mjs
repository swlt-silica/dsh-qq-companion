import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createController} from '../src/host/controller.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-controller-')),events=[];let running=false;
 const supervisor={status:()=>({running,accepting:running}),start:async()=>{events.push('start');running=true;},stop:async()=>{events.push('stop');running=false;},request:async(op,payload)=>{events.push({op,payload});if(op==='blacklist.list'||op==='diary.list'||op==='reports.list')return [];return {online:true};}};
 const initialConfig={identity:{ownerQQ:'11',selfQQ:'12'},connection:{onebotWs:'ws://localhost:3001',dshUrl:'http://localhost:3080'},paths:{stateDir:dir,workspace:dir,dshHome:dir},runtime:{enabled:true},access:{groups:['22'],private:['11']},daily:{enabled:false}};
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,events,supervisor,initialConfig};
}
test('commit gates runtime before revoking scope; stale revision never reaches worker',async t=>{
 const f=fixture(t);const c=await createController({...f,controlDir:path.join(f.dir,'control'),configFile:path.join(f.dir,'worker.json'),legacy:{dsh:{model:'fixture'},deployment:{}}});t.after(()=>c.close());await c.start();f.events.length=0;
 await c.dispatch('config.update',{patch:{access:{groups:[]}}},0);
 const configEvents=f.events.filter(e=>e.op==='config');assert.equal(f.events[1].op,'pause');assert.equal(configEvents[0].payload.deployment.outgoingEnabled,false);assert.deepEqual(configEvents.at(-1).payload.allow.groups,[]);assert.equal(f.events.at(-1).op,'resume');
 const count=f.events.length;await assert.rejects(c.dispatch('config.update',{patch:{access:{groups:['33']}}},0),{code:'REVISION_CONFLICT'});assert.equal(f.events.length,count);
});
test('connection change stays gated until explicit reconnect, without switching a live HTTP target',async t=>{
 const f=fixture(t);const c=await createController({...f,controlDir:path.join(f.dir,'control'),configFile:path.join(f.dir,'worker.json'),legacy:{deployment:{}}});t.after(()=>c.close());await c.start();f.events.length=0;
 await c.dispatch('config.update',{patch:{connection:{onebotWs:'ws://localhost:4001'}}},0);assert.equal((await c.snapshot()).status.pendingReconnect,true);assert.equal(f.events.some(e=>e==='start'),false);
 await c.dispatch('runtime.reconnect',{},1);assert.deepEqual(f.events.filter(e=>typeof e==='string'),['stop','start']);assert.equal((await c.snapshot()).status.pendingReconnect,false);
});
test('WebUI backfill converts bounded calendar range and pause can preempt long management work',async t=>{
 const f=fixture(t);let finish;const original=f.supervisor.request;
 f.supervisor.request=async(op,payload)=>{if(op==='diary.backfill'){f.events.push({op,payload});return new Promise(r=>{finish=r;});}return original(op,payload);};
 const c=await createController({...f,controlDir:path.join(f.dir,'control'),configFile:path.join(f.dir,'worker.json'),legacy:{deployment:{}}});t.after(()=>c.close());await c.start();
 const pending=c.dispatch('diary.backfill',{from:'2026-10-20',to:'2026-10-22'},0);while(!finish)await new Promise(r=>setTimeout(r,1));
 const pause=c.dispatch('runtime.pause',{},0);try{await Promise.race([pause,new Promise((_,reject)=>setTimeout(()=>reject(Error('pause blocked by backfill')),200))]);
 assert.deepEqual(f.events.find(e=>e.op==='diary.backfill').payload.dates,['2026-10-20','2026-10-21','2026-10-22']);}finally{finish([]);await pending;await pause;}
 await assert.rejects(c.dispatch('diary.backfill',{from:'2026-10-01',to:'2026-10-15'},0),{code:'VALIDATION'});
});
