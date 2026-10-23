import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {createHarness, apiFixture, snapshot} from './client-harness.mjs';
const originalFetch=globalThis.fetch;
after(() => { globalThis.fetch=originalFetch; });
const {factory} = await import('../src/client/index.js').catch(() => ({}));

test('native plugin bundle supplies a management page with six accessible sections and no credentials', async () => {
  assert.equal(typeof factory, 'function', 'Native client factory is required');
  const api=apiFixture(), ui=createHarness(factory,api.fetch);
  ui.render();
  assert.match(ui.text(),/加载/);
  await ui.settle();
  assert.equal(ui.registrations[0].options.key,'dsh-qq-companion');
  for (const section of ['运行','名单','主动发言','日记与学习','群报告','用量与审计']) assert.ok(ui.button(section));
  assert.doesNotMatch(JSON.stringify(ui.render()),/MUST-NOT-RENDER|user:secret|secret-directory/);
  await ui.click('Mnemon 原生管理');
  assert.deepEqual(ui.navigated,['dsh-mnemon']);
});
test('report history offers only fixed same-origin downloads for allowed valid dated groups',async()=>{const state=snapshot();state.reports=[{date:'2026-10-22',groupId:'20001',status:'ready'},{date:'../../secret',groupId:'20001',status:'ready'}];const api=apiFixture(state),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('群报告');const tree=JSON.stringify(ui.render());assert.match(tree,/report=20001/);assert.doesNotMatch(tree,/report=20001[^" ]*secret/);});

test('saving uses the committed revision and rereads the server before acknowledging success', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch); await ui.settle();
  await ui.change('机器人名称','新名字'); await ui.click('保存运行设置');
  const post=api.calls.find(call => call.method === 'POST');
  assert.equal(post.url,'/api/qq-companion');
  assert.equal(post.credentials,'same-origin');
  assert.deepEqual(post.body,{action:'config.update',payload:{patch:{identity:{botName:'新名字'},runtime:{enabled:false,inference:true,outgoing:true},cache:{enabled:false}}},revision:3});
  assert.equal(api.calls.at(-1).method,undefined);
  assert.match(ui.text(),/已回读.*4/);
  assert.equal(ui.field('机器人名称').props.value,'新名字');
});

test('conflicts preserve unsaved input and show an actionable error without success', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch); await ui.settle();
  await ui.change('机器人名称','待保存'); api.failNext(); await ui.click('保存运行设置');
  assert.match(ui.text(),/REVISION_CONFLICT/);
  assert.equal(ui.field('机器人名称').props.value,'待保存');
  assert.doesNotMatch(ui.text(),/已回读/);
});

test('failed committed readback does not claim save success', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch); await ui.settle();
  api.failReadback(); await ui.click('保存运行设置');
  assert.match(ui.text(),/回读失败/); assert.doesNotMatch(ui.text(),/已回读/);
  assert.equal(ui.button('保存运行设置').props.disabled,true,'stale revision cannot mutate before a refresh');
  await ui.click('刷新'); assert.equal(ui.button('保存运行设置').props.disabled,false);
});

test('whitelist edits reject invalid IDs and deduplicate valid sources before submitting', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch); await ui.settle(); await ui.click('名单');
  await ui.change('群白名单','20001, 20001\n20002'); await ui.change('私聊白名单','abc'); await ui.click('保存白名单');
  assert.match(ui.text(),/QQ/); assert.equal(api.calls.filter(call => call.method === 'POST').length,0);
  await ui.change('私聊白名单','30001'); await ui.click('保存白名单');
  assert.deepEqual(api.calls.find(call => call.method === 'POST').body.payload,{patch:{access:{groups:['20001','20002'],private:['30001']}}});
});

test('diary is rendered as plain text and downloads only an authorized same-origin date', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch); await ui.settle(); await ui.click('日记与学习'); await ui.click('阅读 2026-10-22');
  assert.match(ui.text(),/<script>unsafe\(\)<\/script>/);
  assert.equal(ui.all(node => node.type === 'script').length,0);
  const link=ui.all(node => node.type === 'a' && node.props.download)[0];
  assert.equal(link.props.href,'/api/qq-companion?diary=2026-10-22&download=1');
  assert.equal(link.props.download,'qq-diary-2026-10-22.md');
  const bad=snapshot();bad.diaries.push({date:'../secret',title:'不合法'});api.current=bad;await ui.click('刷新');
  assert.equal(ui.all(node => node.type === 'a' && String(node.props.href).includes('secret')).length,0);
});

test('source overrides are validated and saved as structured numeric controls', async () => {
  const api=apiFixture(), ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('主动发言');
  await ui.change('来源覆盖 JSON','{"group:20001":{"dailyLimit":2,"minIntervalMinutes":60}}');await ui.click('保存主动发言');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload.patch.proactive.overrides,{'group:20001':{dailyLimit:2,minIntervalMinutes:60}});
});

test('backfill bounds dates and never sends a silent overwrite request', async () => {
  const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('日记与学习');
  await ui.change('补写起始日期','2026-10-01');await ui.change('补写结束日期','2026-10-22');await ui.click('补写缺失日记');
  assert.equal(api.calls.filter(call=>call.method==='POST').length,0);assert.match(ui.text(),/7 天/);
  await ui.change('补写起始日期','2026-10-21');await ui.click('补写缺失日记');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body,{action:'diary.backfill',payload:{from:'2026-10-21',to:'2026-10-22'},revision:3});
});

test('settings import strips credentials before preview and submitted import', async () => {
  const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();
  await ui.field('导入设置文件').props.onChange({target:{files:[{size:500,text:async()=>JSON.stringify({config:{runtime:{enabled:false},connection:{accessToken:'IMPORT-SECRET'},paths:{stateDir:'IMPORT-PATH'},identity:{botName:'导入名称'}}})}],value:'file'}});await ui.settle();
  assert.doesNotMatch(ui.text(),/IMPORT-SECRET|IMPORT-PATH/);await ui.click('应用导入');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload,{config:{identity:{botName:'导入名称'},runtime:{enabled:false}}});
});

test('reports and blacklist submit explicit management actions, metrics show token accounting', async () => {
  const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('名单');
  await ui.change('黑名单 QQ','40002');await ui.change('拉黑原因','人工检查');await ui.click('加入黑名单');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body,{action:'blacklist.add',payload:{userId:'40002',reason:'人工检查'},revision:3});
  await ui.click('群报告');await ui.change('报告日期','2026-10-22');await ui.click('生成群报告');
  assert.deepEqual(api.calls.filter(call=>call.method==='POST').at(-1).body.payload,{groupId:'20001',date:'2026-10-22'});
  await ui.click('用量与审计');assert.match(ui.text(),/100/);assert.match(ui.text(),/80/);assert.match(ui.text(),/12/);
});

test('revoking a source atomically cleans its override and report dependencies',async()=>{
  const state=snapshot();state.config.proactive.overrides={'group:20001':{dailyLimit:2},'private:30001':{enabled:false}};
  const api=apiFixture(state),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('名单');
  await ui.change('群白名单','');await ui.click('保存白名单');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload.patch,{
    access:{groups:[],private:['30001']},
    proactive:{overrides:{'private:30001':{enabled:false}}},
    reports:{groups:[]},
  });
});

test('quiet-window source overrides remain editable and unapproved sources cannot be saved',async()=>{
  const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('主动发言');
  await ui.change('来源覆盖 JSON','{"group:20001":{"quietStart":"22:00","quietEnd":"09:00","timezone":"Asia/Shanghai"}}');await ui.click('保存主动发言');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload.patch.proactive.overrides,{'group:20001':{quietStart:'22:00',quietEnd:'09:00',timezone:'Asia/Shanghai'}});
  await ui.change('来源覆盖 JSON','{"group:99999":{"dailyLimit":2}}');await ui.click('保存主动发言');
  assert.equal(api.calls.filter(call=>call.method==='POST').length,1);assert.match(ui.text(),/白名单/);
});

test('sanitized export downloads a JSON Blob without tokens or local paths and revokes object URL',async()=>{
  const originalDocument=globalThis.document,originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  let blob,clicked=false,removed=false,revoked=false;
  globalThis.document={body:{appendChild(){}},createElement(){return {click(){clicked=true;},remove(){removed=true;}};}};
  URL.createObjectURL=value=>{blob=value;return 'blob:client-test';};URL.revokeObjectURL=value=>{assert.equal(value,'blob:client-test');revoked=true;};
  try {
    const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('导出设置');
    const exported=JSON.parse(await blob.text());
    assert.equal(exported.config.runtime.enabled,false);assert.equal(exported.config.identity.botName,'伴聊');
    assert.equal(exported.config.connection,undefined);assert.equal(exported.config.paths,undefined);
    assert.doesNotMatch(await blob.text(),/MUST-NOT-RENDER|secret/);
    assert.equal(clicked,true);assert.equal(removed,true);
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(revoked,true);
  } finally {globalThis.document=originalDocument;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});

test('failed auth response cannot echo a credential into the DOM',async()=>{
  const ui=createHarness(factory,async()=>Response.json({ok:false,error:{code:'UNAUTHORIZED',message:'credential=DO-NOT-ECHO'}},{status:401}));
  await ui.settle();assert.match(ui.text(),/UNAUTHORIZED/);assert.doesNotMatch(ui.text(),/DO-NOT-ECHO/);
});

test('revoking owner private source disables private learning in the same revision',async()=>{
  const state=snapshot();state.config.access.private=['10001'];state.config.daily.includeOwnerPrivate=true;
  const api=apiFixture(state),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('名单');await ui.change('私聊白名单','');await ui.click('保存白名单');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload.patch,{access:{groups:['20001'],private:[]},daily:{includeOwnerPrivate:false}});
});

test('client accepts the full control-layer ID contract and displays supplied cache hit rate',async()=>{
  const state=snapshot();state.config.access.groups=['1'];state.config.reports.groups=['1'];state.metrics.cacheHitRate=0.8;
  const api=apiFixture(state),ui=createHarness(factory,api.fetch);await ui.settle();
  await ui.click('用量与审计');assert.match(ui.text(),/80%/);
  await ui.click('名单');await ui.click('保存白名单');
  assert.deepEqual(api.calls.find(call=>call.method==='POST').body.payload.patch.access.groups,['1']);
});

test('daily skill settings reject fewer than three successes and allow documented upper bound',async()=>{
  const api=apiFixture(),ui=createHarness(factory,api.fetch);await ui.settle();await ui.click('日记与学习');
  await ui.change('技能最低成功次数','2');await ui.click('保存学习设置');
  assert.equal(api.calls.filter(call=>call.method==='POST').length,0);
  await ui.change('技能最低成功次数','1000');await ui.click('保存学习设置');
  assert.equal(api.calls.find(call=>call.method==='POST').body.payload.patch.daily.skillMinSuccesses,1000);
});

test('a stale readback cannot acknowledge a newer committed revision',async()=>{
  const api=apiFixture();let posted=false;
  const ui=createHarness(factory,async(url,options={})=>{
    if(options.method==='POST')posted=true;
    else if(posted)return Response.json({ok:true,value:snapshot(3)});
    return api.fetch(url,options);
  });
  await ui.settle();await ui.change('机器人名称','新提交');await ui.click('保存运行设置');
  assert.match(ui.text(),/回读失败/);assert.doesNotMatch(ui.text(),/已回读/);
  assert.equal(ui.field('机器人名称').props.value,'新提交');
});
