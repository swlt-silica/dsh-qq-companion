import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createHarness,apiFixture} from './client-harness.mjs';

test('built native module round-trips its self-contained factory and performs committed HTTP readback',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const built=spawnSync(process.execPath,['scripts/build-client.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  let registered;
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(value){registered=value;}}},fetch:(...args)=>globalThis.fetch(...args),Intl,Date,URL,Blob,setTimeout});
  assert.equal(registered.id,'dsh-qq-companion');
  const original=globalThis.fetch;
  try {
    const api=apiFixture(),ui=createHarness(registered.factory,api.fetch);
    await ui.settle();await ui.change('机器人名称','构建后的客户端');await ui.click('保存运行设置');
    assert.equal(api.current.config.identity.botName,'构建后的客户端');
    assert.match(ui.text(),/已回读.*4/);
  } finally {globalThis.fetch=original;}
});
