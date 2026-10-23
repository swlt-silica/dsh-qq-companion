import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSupervisor} from '../src/host/supervisor.mjs';
const worker=fileURLToPath(new URL('./fixtures/worker.mjs',import.meta.url));
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-supervisor-'));const s=createSupervisor({worker,stateDir:dir,configFile:path.join(dir,'worker.json'),requestTimeout:80,startTimeout:2000,maxRestarts:0});t.after(async()=>{await s.stop();fs.rmSync(dir,{recursive:true,force:true});});return {s,dir};}
test('worker lifecycle is idempotent and requests are correlated; shutdown gates before process exit',async t=>{
 const {s}=setup(t);await s.start();const pid=s.status().pid;await s.start();assert.equal(s.status().pid,pid);
 assert.equal((await s.request('status')).op,'status');const stop=s.stop();assert.equal(s.status().accepting,false);
 await assert.rejects(s.request('resume'),/stopp|running|disabled/i);await stop;assert.equal(s.status().running,false);
});
test('only one host owns a state directory and stale locks are recoverable',async t=>{
 const {s,dir}=setup(t);await s.start();const other=createSupervisor({worker,stateDir:dir,configFile:path.join(dir,'worker.json')});
 await assert.rejects(other.start(),/already|owner|lock/i);await s.stop();await other.start();await other.stop();
});
test('timeouts and crash reject pending calls without retrying operations',async t=>{
 const {s}=setup(t);await s.start();await assert.rejects(s.request('hang'),/timed out/i);
 await assert.rejects(s.request('crash'),/exited/i);assert.equal(s.status().running,false);assert.equal(s.status().restarts,0);
});
