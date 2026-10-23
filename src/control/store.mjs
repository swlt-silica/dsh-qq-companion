import { mkdir, readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlError, assertManagement, assertSafeObject, mergeConfig, validateConfig, sanitizedConfig, sanitizeValue } from './config.mjs';
import { emptyMetrics, aggregateTokenMetrics } from './metrics.mjs';
export { ControlError, defaultConfig, validateConfig, assertManagement, isSourceAllowed, assertBlockTarget, sanitizeValue } from './config.mjs';
export { createBlacklistAdapter } from './blacklist.mjs';
export { aggregateTokenMetrics } from './metrics.mjs';

const MAX_AUDIT = 500;
const MAX_AUDIT_ENTRY_BYTES = 4096;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const serializedBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const persistenceError = () => new ControlError('PERSISTENCE', 'Unable to persist management state; runtime gates may remain restricted', 500);
async function readState(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw persistenceError();
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.format !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !Array.isArray(value.audit) || value.audit.length > MAX_AUDIT
      || value.audit.some(entry => serializedBytes(entry) > MAX_AUDIT_ENTRY_BYTES)) throw persistenceError();
    value.config = validateConfig(value.config);
    const metrics = value.metrics;
    if (!metrics || Object.keys(emptyMetrics()).some(key => typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0)) throw persistenceError();
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw persistenceError(); }
}
async function stage(file, state) {
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES)
    throw new ControlError('VALIDATION', 'Management state exceeds the supported size limit', 413);
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    return temp;
  } catch { if (handle) await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw persistenceError(); }
}
async function publish(temp, file) { try { await rename(temp, file); } catch { throw persistenceError(); } }

export async function createControlStore({ dir, initialConfig = {}, onCommit = async () => {}, now = () => new Date() }) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new ControlError('VALIDATION', 'Control state directory must be absolute');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'control.json');
  const lock = join(dir, 'control.lock');
  let state = await readState(file);
  if (!state) {
    state = { format: 1, revision: 0, sequence: 0, config: validateConfig(initialConfig), audit: [], metrics: emptyMetrics() };
    const temp = await stage(file, state);
    // Initial publication must not replace a concurrently created store.
    let handle;
    try { handle = await open(lock, 'wx', 0o600); const existing = await readState(file); if (existing) state = existing; else await publish(temp, file); }
    catch (error) { if (error.code === 'EEXIST') throw new ControlError('REVISION_CONFLICT', 'Control state is busy', 409); throw error; }
    finally { if (handle) { await handle.close(); await unlink(lock).catch(() => {}); } await unlink(temp).catch(() => {}); }
  }
  let queue = Promise.resolve(); let closed = false;
  const secrets = new Set([state.config.connection.accessToken, state.config.connection.wsAccessToken, state.config.connection.dshToken].filter(Boolean));
  function snapshot() { return { revision: state.revision, config: sanitizedConfig(state.config),
    audit: sanitizeValue(state.audit, secrets), metrics: structuredClone(state.metrics) }; }
  function enqueue(principal, operation) {
    try { assertManagement(principal); if (closed) throw new ControlError('CLOSED', 'Control store is closed', 503); }
    catch (error) { return Promise.reject(error); }
    const result = queue.then(async () => {
      let handle;
      try {
        handle = await open(lock, 'wx', 0o600);
        const disk = await readState(file);
        if (!disk || disk.sequence !== state.sequence) throw new ControlError('REVISION_CONFLICT', 'Management state changed; reload before saving', 409);
        return await operation();
      } catch (error) { if (error.code === 'EEXIST') throw new ControlError('REVISION_CONFLICT', 'Control state is busy', 409); throw error; }
      finally { if (handle) { await handle.close(); await unlink(lock).catch(() => {}); } }
    });
    queue = result.catch(() => {}); return result;
  }
  function entry(action, details) {
    if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/i.test(action)) throw new ControlError('VALIDATION', 'Invalid audit action');
    const value = { at: new Date(now()).toISOString(), principal: 'management', action: sanitizeValue(action, secrets), details: sanitizeValue(details, secrets) };
    if (serializedBytes(value) > MAX_AUDIT_ENTRY_BYTES)
      throw new ControlError('VALIDATION', 'Audit entry exceeds the supported size limit', 413);
    return value;
  }
  async function save(next, beforePublish) {
    next.sequence = state.sequence + 1;
    const temp = await stage(file, next);
    try { if (beforePublish) await beforePublish(); await publish(temp, file); state = next; }
    finally { await unlink(temp).catch(() => {}); }
  }
  async function change(patch, revision, action) {
    if (!Number.isSafeInteger(revision) || revision !== state.revision) throw new ControlError('REVISION_CONFLICT', 'Configuration revision changed; reload before saving', 409);
    const config = validateConfig(mergeConfig(state.config, patch));
    secrets.add(config.connection.accessToken); secrets.add(config.connection.wsAccessToken); secrets.add(config.connection.dshToken);
    const next = { ...state, revision: state.revision + 1, config,
      audit: [...state.audit, entry(action, { revision: state.revision + 1 })].slice(-MAX_AUDIT) };
    await save(next, async () => {
      try { await onCommit(structuredClone(config), structuredClone(state.config)); }
      catch { throw new ControlError('COMMIT_FAILED', 'Runtime configuration was not acknowledged; existing revision retained', 503); }
    });
    return snapshot();
  }
  const store = {
    snapshot,
    // Host-only capability: never include the store object itself in an API response.
    rawConfig: () => structuredClone(state.config),
    async update(patch, revision, principal) {
      assertManagement(principal); assertSafeObject(patch);
      const captured = structuredClone(patch);
      return enqueue(principal, () => change(captured, revision, 'config.update'));
    },
    exportConfig(principal) { assertManagement(principal); return sanitizedConfig(state.config); },
    async importConfig(value, revision, principal) {
      assertManagement(principal); assertSafeObject(value);
      const captured = structuredClone(value);
      return enqueue(principal, () => {
        const patch = captured;
        if (patch.connection) for (const key of ['accessTokenConfigured', 'wsAccessTokenConfigured', 'dshTokenConfigured']) {
          if (Object.hasOwn(patch.connection, key)) {
            if (typeof patch.connection[key] !== 'boolean') throw new ControlError('VALIDATION', 'Invalid configured flag');
            delete patch.connection[key];
          }
        }
        return change(patch, revision, 'config.import');
      });
    },
    async audit(action, details = {}, principal) {
      assertManagement(principal); assertSafeObject(details, 'audit');
      const captured = structuredClone(details);
      return enqueue(principal, async () => {
        const next = { ...state, audit: [...state.audit, entry(action, captured)].slice(-MAX_AUDIT) };
        await save(next); return sanitizeValue(next.audit.at(-1), secrets);
      });
    },
    async recordMetrics(usage, principal) {
      assertManagement(principal); assertSafeObject(usage, 'metrics');
      const captured = structuredClone(usage);
      return enqueue(principal, async () => {
        const next = { ...state, metrics: aggregateTokenMetrics(state.metrics, captured) };
        await save(next); return structuredClone(next.metrics);
      });
    },
    async close() { closed = true; await queue; },
  };
  return store;
}
