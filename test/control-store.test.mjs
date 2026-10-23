import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const control = await import('../src/control/store.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const management = { kind: 'management' };
async function fixture(t, options = {}) {
  assert.equal(typeof control.createControlStore, 'function', 'control store implementation exists');
  const dir = await mkdtemp(join(tmpdir(), 'qq-control-'));
  const store = await control.createControlStore({ dir, ...options });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('safe defaults disable runtime and make daily learning public-only', async t => {
  const { store } = await fixture(t);
  const { revision, config } = store.snapshot();
  assert.equal(revision, 0);
  assert.deepEqual(config.access, { groups: [], private: [] });
  assert.deepEqual(config.runtime, { enabled: false, inference: true, outgoing: true });
  assert.deepEqual(config.proactive, { enabled: true, dailyLimit: 10, minIntervalMinutes: 30,
    interjectProbability: 0.05, groupIdleMinutes: 30, privateIdleMinutes: 120,
    quietStart: '23:00', quietEnd: '08:00', timezone: 'Asia/Shanghai', overrides: {} });
  assert.equal(config.daily.time, '00:05');
  assert.equal(config.daily.includeOwnerPrivate, false);
  config.proactive.dailyLimit = 999;
  assert.equal(store.snapshot().config.proactive.dailyLimit, 10);
});

test('only trusted management may mutate, export or import', async t => {
  const { store } = await fixture(t);
  for (const principal of [undefined, {}, { kind: 'agent' }, { kind: 'management', agentToken: 'bad' }]) {
    await assert.rejects(async () => store.update({ cache: { enabled: true } }, 0, principal), { code: 'FORBIDDEN' });
    await assert.rejects(async () => store.importConfig({}, 0, principal), { code: 'FORBIDDEN' });
    await assert.rejects(async () => store.exportConfig(principal), { code: 'FORBIDDEN' });
    await assert.rejects(async () => store.audit('attempt', {}, principal), { code: 'FORBIDDEN' });
  }
  assert.equal(store.snapshot().revision, 0);
});

test('secrets remain private through snapshots, export, audit and committed readback', async t => {
  const { store, dir } = await fixture(t, { initialConfig: { connection: { accessToken: 'first-secret', dshToken: 'other-secret' } } });
  const saved = await store.update({ connection: { accessToken: 'new-secret' } }, 0, management);
  assert.equal(saved.config.connection.accessTokenConfigured, true);
  assert.equal(saved.config.connection.dshTokenConfigured, true);
  assert.equal(Object.hasOwn(saved.config.connection, 'accessToken'), false);
  assert.equal(store.rawConfig().connection.accessToken, 'new-secret');
  const raw = store.rawConfig(); raw.connection.accessToken = 'tampered';
  assert.equal(store.rawConfig().connection.accessToken, 'new-secret');
  const exported = await store.exportConfig(management);
  assert.doesNotMatch(JSON.stringify([saved, exported]), /first-secret|new-secret|other-secret/);
  await store.audit('config.test', { accessToken: 'new-secret', nested: { password: 'secret' }, message: 'new-secret other-secret' }, management);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /first-secret|new-secret|other-secret|"secret"/);
  const disk = JSON.parse(await readFile(join(dir, 'control.json'), 'utf8'));
  assert.equal(disk.config.connection.accessToken, 'new-secret');
});

test('round-trip sanitized export preserves credentials while explicit empty clears them', async t => {
  const { store } = await fixture(t, { initialConfig: { connection: { accessToken: 'retained' } } });
  const exported = await store.exportConfig(management);
  const saved = await store.importConfig(exported, 0, management);
  assert.equal(saved.revision, 1);
  assert.equal(store.rawConfig().connection.accessToken, 'retained');
  await store.update({ connection: { accessToken: '' } }, 1, management);
  assert.equal(store.snapshot().config.connection.accessTokenConfigured, false);
});

test('validation rejects unknown, unsafe, invalid and masked values without changing revision', async t => {
  const { store } = await fixture(t);
  const invalid = [
    { unknown: true }, { runtime: { surprise: true } }, JSON.parse('{"__proto__":{"polluted":true}}'),
    { proactive: { dailyLimit: -1 } }, { proactive: { interjectProbability: 1.01 } },
    { proactive: { minIntervalMinutes: 0 } }, { proactive: { quietStart: '24:00' } },
    { proactive: { timezone: 'No/SuchZone' } }, { daily: { time: '8:05' } },
    { access: { groups: ['*'] } }, { access: { private: ['not-a-qq'] } },
    { connection: { onebotWs: 'http://localhost' } },
    { connection: { dshUrl: 'https://user:password@example.test' } },
    { connection: { onebotHttp: 'http://localhost/?access_token=hidden' } },
    { connection: { accessToken: '********' } }, { paths: { stateDir: '../outside' } },
    { identity: { ownerQQ: '123', selfQQ: '123' } }, { runtime: { enabled: true } },
    { proactive: { overrides: { 'group:100': { enabled: true } } } },
    { reports: { groups: ['100'] } }, { daily: { sampleChars: 10000001 } },
  ];
  for (const patch of invalid) {
    await assert.rejects(() => store.update(patch, 0, management), { code: 'VALIDATION' });
    assert.equal(store.snapshot().revision, 0);
  }
  assert.equal({}.polluted, undefined);
});

test('whitelist and source overrides accept scoped values and reject report-only groups', async t => {
  const { store } = await fixture(t);
  await store.update({ access: { groups: ['100', '100'], private: ['200'] },
    proactive: { overrides: { 'group:100': { dailyLimit: 2, interjectProbability: 0 }, 'private:200': { enabled: false } } },
    reports: { groups: ['100'] } }, 0, management);
  assert.deepEqual(store.snapshot().config.access.groups, ['100']);
  assert.equal(store.snapshot().config.proactive.overrides['group:100'].dailyLimit, 2);
  await assert.rejects(() => store.update({ access: { groups: [] } }, 1, management), { code: 'VALIDATION' });
  assert.equal(control.isSourceAllowed(store.rawConfig(), 'group', '100'), true);
  assert.equal(control.isSourceAllowed(store.rawConfig(), 'group', '999'), false);
  assert.equal(control.isSourceAllowed(store.rawConfig(), 'private', '200'), true);
  assert.equal(control.isSourceAllowed(store.rawConfig(), 'report', '100'), false);
});

test('onCommit completes revocation before persistence or acknowledgement and sees full secrets', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const { store, dir } = await fixture(t, { initialConfig: { connection: { accessToken: 'raw-secret' }, access: { groups: ['100'] } },
    onCommit: async (next, previous) => { assert.equal(next.connection.accessToken, 'raw-secret'); assert.deepEqual(previous.access.groups, ['100']); entered(); await gate; } });
  let acknowledged = false;
  const pending = store.update({ access: { groups: [] } }, 0, management).then(value => { acknowledged = true; return value; });
  await started;
  assert.equal(acknowledged, false);
  assert.deepEqual(store.snapshot().config.access.groups, ['100']);
  assert.equal(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')).revision, 0);
  release(); await pending;
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().config.access.groups, []);
});

test('failed revocation leaves old revision on disk and queue recovers', async t => {
  let deny = true;
  const { store, dir } = await fixture(t, { onCommit: async () => { if (deny) throw new Error('gate unavailable'); } });
  await assert.rejects(() => store.update({ cache: { enabled: true } }, 0, management), { code: 'COMMIT_FAILED' });
  assert.equal(store.snapshot().revision, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')).revision, 0);
  deny = false;
  await store.update({ cache: { enabled: true } }, 0, management);
  assert.equal(store.snapshot().revision, 1);
});

test('concurrent saves with same revision permit exactly one and reload preserves committed value', async t => {
  const { store, dir } = await fixture(t);
  const outcomes = await Promise.allSettled([
    store.update({ cache: { enabled: true } }, 0, management),
    store.update({ daily: { enabled: false } }, 0, management),
  ]);
  assert.deepEqual(outcomes.map(value => value.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.code, 'REVISION_CONFLICT');
  await store.close();
  const reopened = await control.createControlStore({ dir, initialConfig: { cache: { enabled: false } } });
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(reopened.snapshot().config.cache.enabled, true);
  assert.equal(reopened.snapshot().config.daily.enabled, true);
});

test('stale store cannot replace a newer disk revision and malformed disk fails closed', async t => {
  const { store, dir } = await fixture(t);
  const second = await control.createControlStore({ dir }); t.after(() => second.close());
  await store.update({ cache: { enabled: true } }, 0, management);
  await assert.rejects(() => second.update({ daily: { enabled: false } }, 0, management), { code: 'REVISION_CONFLICT' });
  await second.close(); await store.close();
  await writeFile(join(dir, 'control.json'), '{broken');
  await assert.rejects(async () => control.createControlStore({ dir }), { code: 'PERSISTENCE' });
});

test('bounded audit is persisted, sanitized and cannot change configuration', async t => {
  const { store, dir } = await fixture(t, { now: () => new Date('2026-01-02T03:04:05Z') });
  await store.audit('blacklist.add', { target: '345', reason: 'private reason', token: 'hidden' }, management);
  const entry = store.snapshot().audit.at(-1);
  assert.equal(entry.action, 'blacklist.add');
  assert.equal(entry.at, '2026-01-02T03:04:05.000Z');
  assert.equal(entry.details.target, '345');
  assert.equal(entry.details.token, undefined);
  assert.equal(store.snapshot().revision, 0);
  await store.close();
  const reopened = await control.createControlStore({ dir }); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().audit.at(-1).action, 'blacklist.add');
});

test('metrics distinguish uncached, cache-read and cache-write token buckets', async t => {
  const { store } = await fixture(t);
  await store.recordMetrics({ inputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 7, latencyMs: 90 }, management);
  await store.recordMetrics({ inputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3, latencyMs: 10 }, management);
  const metrics = store.snapshot().metrics;
  assert.equal(metrics.requests, 2);
  assert.equal(metrics.inputTokens, 110);
  assert.equal(metrics.uncachedInputTokens, 45);
  assert.equal(metrics.cacheReadTokens, 55);
  assert.equal(metrics.cacheWriteTokens, 10);
  assert.equal(metrics.outputTokens, 10);
  assert.equal(metrics.cacheHitRate, 0.5);
  await assert.rejects(() => store.recordMetrics({ inputTokens: -1 }, management), { code: 'VALIDATION' });
  await assert.rejects(() => store.recordMetrics({}, { kind: 'agent' }), { code: 'FORBIDDEN' });
});

test('blacklist adapter uses authoritative worker DB and protects owner and self', async t => {
  const { store } = await fixture(t, { initialConfig: { identity: { ownerQQ: '111', selfQQ: '222' } } });
  let rows = []; const operations = [];
  const adapter = control.createBlacklistAdapter({ getConfig: () => store.rawConfig(), audit: store.audit,
    request: async (op, payload) => { operations.push(op); if (op === 'blacklist.add') rows.push({ userId: payload.userId }); if (op === 'blacklist.release') rows = []; return structuredClone(rows); } });
  for (const id of ['111', '222']) await assert.rejects(() => adapter.add(id, management), { code: 'PROTECTED_IDENTITY' });
  await assert.rejects(() => adapter.add('333', { kind: 'agent' }), { code: 'FORBIDDEN' });
  await adapter.add('333', management);
  assert.deepEqual(await adapter.list(management), [{ userId: '333' }]);
  await adapter.release('333', management);
  assert.deepEqual(await adapter.list(management), []);
  assert.deepEqual(operations, ['blacklist.add', 'blacklist.list', 'blacklist.release', 'blacklist.list']);
  assert.equal(Object.hasOwn(store.rawConfig(), 'blacklist'), false);
});

test('wrong section types and non-JSON objects fail validation without calling runtime', async t => {
  let commits = 0;
  const { store } = await fixture(t, { onCommit: async () => { commits++; } });
  for (const patch of [{ runtime: null }, { connection: [] }, { proactive: false }, { identity: 123 },
    { cache: new Date() }, { access: { groups: [undefined] } }, { daily: { enabled: () => true } }]) {
    await assert.rejects(() => store.update(patch, 0, management), { code: 'VALIDATION' });
  }
  assert.equal(commits, 0);
});

test('input is captured at invocation so later caller mutations cannot alter queued saves', async t => {
  const { store } = await fixture(t);
  const patch = { cache: { enabled: true } };
  const pending = store.update(patch, 0, management);
  patch.cache.enabled = false;
  await pending;
  assert.equal(store.snapshot().config.cache.enabled, true);
});

test('persistence failure after revocation rejects acknowledgement and removes staging file', async t => {
  let closedGate = false; let dir;
  const result = await fixture(t, { onCommit: async () => {
    closedGate = true;
    await rm(join(dir, 'control.json'));
    await mkdir(join(dir, 'control.json'));
  } });
  dir = result.dir;
  await assert.rejects(() => result.store.update({ cache: { enabled: true } }, 0, management), { code: 'PERSISTENCE' });
  assert.equal(closedGate, true);
  assert.equal(result.store.snapshot().revision, 0);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp') || name === 'control.lock'), false);
});

test('closed stores reject management writes and do not create new state', async t => {
  const { store } = await fixture(t);
  await store.close();
  await assert.rejects(() => store.update({ cache: { enabled: true } }, 0, management), { code: 'CLOSED' });
  await assert.rejects(() => store.recordMetrics({}, management), { code: 'CLOSED' });
  assert.equal(store.snapshot().revision, 0);
});

test('audit retention stays bounded without dropping configuration or metrics', async t => {
  const { store } = await fixture(t);
  await store.recordMetrics({ inputTokens: 5 }, management);
  for (let i = 0; i < 502; i++) await store.audit('manage.action', { index: i }, management);
  const snapshot = store.snapshot();
  assert.equal(snapshot.audit.length, 500);
  assert.equal(snapshot.audit[0].details.index, 2);
  assert.equal(snapshot.audit.at(-1).details.index, 501);
  assert.equal(snapshot.metrics.uncachedInputTokens, 5);
  assert.equal(snapshot.revision, 0);
});

test('onCommit cannot mutate the prepared configuration and getters never run', async t => {
  const { store } = await fixture(t, { onCommit: async next => { next.cache.enabled = false; } });
  let accessed = false;
  const patch = {}; Object.defineProperty(patch, 'cache', { enumerable: true, get() { accessed = true; return { enabled: true }; } });
  await assert.rejects(() => store.update(patch, 0, management), { code: 'VALIDATION' });
  assert.equal(accessed, false);
  await store.update({ cache: { enabled: true } }, 0, management);
  assert.equal(store.snapshot().config.cache.enabled, true);
});

test('distinct websocket credentials stay private and survive sanitized import', async t => {
  const { store } = await fixture(t, { initialConfig: { connection: { wsAccessToken: 'ws-only-secret', accessToken: 'http-only-secret' } } });
  const config = await store.exportConfig(management);
  assert.equal(config.connection.wsAccessTokenConfigured, true);
  assert.equal(Object.hasOwn(config.connection, 'wsAccessToken'), false);
  assert.doesNotMatch(JSON.stringify(config), /ws-only-secret|http-only-secret/);
  await store.importConfig(config, 0, management);
  assert.equal(store.rawConfig().connection.wsAccessToken, 'ws-only-secret');
  assert.equal(store.rawConfig().connection.accessToken, 'http-only-secret');
  await store.audit('connection.change', { message: 'ws-only-secret' }, management);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /ws-only-secret/);
});

test('blacklist reason is validated and passed only to authoritative worker storage', async t => {
  const { store } = await fixture(t);
  let received;
  const adapter = control.createBlacklistAdapter({ getConfig: () => store.rawConfig(),
    request: async (_op, payload) => { received = payload; return { userId: payload.userId }; } });
  await adapter.add('333', management, 'Repeated boundary violation');
  assert.deepEqual(received, { userId: '333', reason: 'Repeated boundary violation' });
  await assert.rejects(() => adapter.add('444', management, { arbitrary: true }), { code: 'VALIDATION' });
  assert.equal(received.userId, '333');
});

test('long configured secrets are redacted before audit truncation, including metadata keys', async t => {
  const secret = 'sensitive-prefix-' + 'q'.repeat(5000);
  const { store, dir } = await fixture(t, { initialConfig: { connection: { accessToken: secret } } });
  await store.audit('long.message', { message: `before ${secret} after`, [secret]: 'metadata' }, management);
  const entry = store.snapshot().audit.at(-1);
  assert.equal(entry.details.message, 'before [redacted] after');
  assert.equal(entry.details['[redacted]'], 'metadata');
  const persisted = await readFile(join(dir, 'control.json'), 'utf8');
  const auditText = JSON.stringify(JSON.parse(persisted).audit);
  assert.equal(auditText.includes(secret.slice(0, 100)), false);
});

test('oversized audit entries are rejected before writes and leave the store reopenable', async t => {
  const { store, dir } = await fixture(t);
  const details = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, 'x'.repeat(4096)]));
  for (let i = 0; i < 11; i++) await assert.rejects(() => store.audit('large.entry', details, management), { code: 'VALIDATION' });
  assert.deepEqual(store.snapshot().audit, []);
  await store.audit('small.entry', { message: 'still usable' }, management);
  await store.close();
  const reopened = await control.createControlStore({ dir }); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().audit.at(-1).action, 'small.entry');
});

test('serialized state size is checked before invoking runtime or replacing the disk revision', async t => {
  const { store, dir } = await fixture(t);
  await store.close();
  const file = join(dir, 'control.json');
  const seeded = JSON.parse(await readFile(file, 'utf8'));
  seeded.audit = Array.from({ length: 500 }, () => ({ at: '2026-01-01T00:00:00.000Z', principal: 'management',
    action: 'seeded.entry', details: { message: 'x'.repeat(3900) } }));
  const baseline = JSON.stringify(seeded) + '\n';
  await writeFile(file, baseline);
  let commits = 0;
  const reopened = await control.createControlStore({ dir, onCommit: async () => { commits++; } });
  t.after(() => reopened.close());
  const groupIds = Array.from({ length: 10000 }, (_, i) => (10000000000000000000n + BigInt(i)).toString());
  const override = { enabled: true, dailyLimit: 10, minIntervalMinutes: 30, interjectProbability: 0.05,
    groupIdleMinutes: 30, privateIdleMinutes: 120, quietStart: '23:00', quietEnd: '08:00', timezone: 'America/Argentina/ComodRivadavia' };
  const patch = { access: { groups: groupIds }, proactive: { overrides: Object.fromEntries(groupIds.map(id => [`group:${id}`, override])) } };
  await assert.rejects(() => reopened.update(patch, 0, management), { code: 'VALIDATION' });
  assert.equal(commits, 0);
  assert.equal(reopened.snapshot().revision, 0);
  assert.equal(await readFile(file, 'utf8'), baseline);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp') || name === 'control.lock'), false);
});
