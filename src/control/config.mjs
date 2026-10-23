import { isAbsolute, win32 } from 'node:path';

export class ControlError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'ControlError'; this.code = code; this.status = status; }
}
const fail = path => { throw new ControlError('VALIDATION', `Invalid configuration field: ${path}`); };
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function assertSafeObject(value, path = 'config', depth = 0) {
  if (!plain(value) || depth > 12) fail(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || unsafe.has(key)) fail(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail(path);
    assertJsonValue(descriptor.value, `${path}.${key}`, depth + 1);
  }
}
function assertJsonValue(value, path, depth) {
  if (depth > 12) fail(path);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(path); return; }
  if (Array.isArray(value)) {
    if (value.length > 10000) fail(path);
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || descriptor.get || descriptor.set) fail(path);
      assertJsonValue(descriptor.value, path, depth + 1);
    }
    return;
  }
  assertSafeObject(value, path, depth);
}
export function assertManagement(principal) {
  if (!plain(principal) || principal.kind !== 'management' || Object.keys(principal).some(key => /agent|token/i.test(key)))
    throw new ControlError('FORBIDDEN', 'Trusted management authentication required', 403);
}
export function defaultConfig() {
  return {
    connection: { onebotWs: '', onebotHttp: '', accessToken: '', wsAccessToken: '', dshUrl: '', dshToken: '' },
    identity: { ownerQQ: '', selfQQ: '', botName: 'QQ Companion' },
    access: { groups: [], private: [] },
    runtime: { enabled: false, inference: true, outgoing: true },
    proactive: { enabled: true, dailyLimit: 10, minIntervalMinutes: 30, interjectProbability: 0.05,
      groupIdleMinutes: 30, privateIdleMinutes: 120, quietStart: '23:00', quietEnd: '08:00', timezone: 'Asia/Shanghai', overrides: {} },
    daily: { enabled: true, time: '00:05', includeOwnerPrivate: false, sampleChars: 16000, skillMinSuccesses: 3 },
    reports: { enabled: true, hour: 21, groups: [] },
    paths: { stateDir: '', workspace: '', dshHome: '', mnemonModuleRoot: '', mnemonDataDir: '' },
    cache: { enabled: false },
  };
}
export function mergeConfig(base, patch) {
  assertSafeObject(patch);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(base, key)) fail(key);
    if (plain(base[key]) && !plain(value)) fail(key);
    // Source overrides are a replacement map; omission preserves the map.
    if (key === 'overrides') result[key] = structuredClone(value);
    else if (plain(value) && plain(base[key])) result[key] = mergeConfig(base[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}
const string = (value, path, max = 4096) => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(path); };
const bool = (value, path) => { if (typeof value !== 'boolean') fail(path); };
const num = (value, path, min, max, integer = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) fail(path);
};
export function validateQQ(value, path = 'QQ', blank = false) {
  if (typeof value !== 'string' || (!(blank && value === '') && !/^[1-9]\d{0,19}$/.test(value))) fail(path);
  return value;
}
function ids(values, path) {
  if (!Array.isArray(values) || values.length > 10000) fail(path);
  return [...new Set(values.map(value => validateQQ(value, path)))];
}
function time(value, path) { if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(path); }
function endpoint(value, path, protocols) {
  string(value, path); if (!value) return;
  let url; try { url = new URL(value); } catch { fail(path); }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => /token|key|secret|auth|password|credential/i.test(key))) fail(path);
}
const proactiveKeys = new Set(['enabled', 'dailyLimit', 'minIntervalMinutes', 'interjectProbability', 'groupIdleMinutes', 'privateIdleMinutes', 'quietStart', 'quietEnd', 'timezone']);
function proactive(value, path, partial = false) {
  assertSafeObject(value, path);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'overrides' && !partial) continue;
    if (!proactiveKeys.has(key)) fail(`${path}.${key}`);
    if (key === 'enabled') bool(field, `${path}.${key}`);
    else if (key === 'dailyLimit') num(field, `${path}.${key}`, 0, 1000);
    else if (key === 'interjectProbability') num(field, `${path}.${key}`, 0, 1, false);
    else if (key === 'quietStart' || key === 'quietEnd') time(field, `${path}.${key}`);
    else if (key === 'timezone') {
      string(field, `${path}.${key}`, 100);
      try { new Intl.DateTimeFormat('en', { timeZone: field }); } catch { fail(`${path}.${key}`); }
    } else num(field, `${path}.${key}`, 1, 525600);
  }
}
export function isSourceAllowed(config, type, id) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) return false;
  return type === 'group' ? config.access.groups.includes(id) : type === 'private' ? config.access.private.includes(id) : false;
}
export function assertBlockTarget(config, userId) {
  validateQQ(userId);
  if (userId === config.identity.ownerQQ || userId === config.identity.selfQQ)
    throw new ControlError('PROTECTED_IDENTITY', 'Owner and bot identity cannot be blacklisted', 403);
}
export function validateConfig(value) {
  // Merge also rejects unknown keys at every ordinary object level.
  const config = mergeConfig(defaultConfig(), value);
  const { connection, identity, access, runtime, daily, reports, paths } = config;
  endpoint(connection.onebotWs, 'connection.onebotWs', ['ws:', 'wss:']);
  endpoint(connection.onebotHttp, 'connection.onebotHttp', ['http:', 'https:']);
  endpoint(connection.dshUrl, 'connection.dshUrl', ['http:', 'https:']);
  for (const key of ['accessToken', 'wsAccessToken', 'dshToken']) {
    string(connection[key], `connection.${key}`, 16384);
    if (/^(?:\*{3,}|•{3,}|\[?redacted\]?|<redacted>|<unchanged>|MASKED)$/i.test(connection[key])) fail(`connection.${key}`);
  }
  validateQQ(identity.ownerQQ, 'identity.ownerQQ', true); validateQQ(identity.selfQQ, 'identity.selfQQ', true);
  string(identity.botName, 'identity.botName', 100); if (!identity.botName.trim()) fail('identity.botName');
  if (identity.ownerQQ && identity.ownerQQ === identity.selfQQ) fail('identity.selfQQ');
  access.groups = ids(access.groups, 'access.groups'); access.private = ids(access.private, 'access.private');
  for (const [key, field] of Object.entries(runtime)) bool(field, `runtime.${key}`);
  proactive(config.proactive, 'proactive');
  assertSafeObject(config.proactive.overrides, 'proactive.overrides');
  if (Object.keys(config.proactive.overrides).length > 10000) fail('proactive.overrides');
  for (const [source, override] of Object.entries(config.proactive.overrides)) {
    const match = /^(group|private):([1-9]\d{0,19})$/.exec(source);
    if (!match || !isSourceAllowed(config, match[1], match[2])) fail('proactive.overrides');
    proactive(override, `proactive.overrides.${source}`, true);
  }
  bool(daily.enabled, 'daily.enabled'); bool(daily.includeOwnerPrivate, 'daily.includeOwnerPrivate'); time(daily.time, 'daily.time');
  num(daily.sampleChars, 'daily.sampleChars', 1, 1000000); num(daily.skillMinSuccesses, 'daily.skillMinSuccesses', 3, 1000);
  if (daily.includeOwnerPrivate && !access.private.includes(identity.ownerQQ)) fail('daily.includeOwnerPrivate');
  bool(reports.enabled, 'reports.enabled'); num(reports.hour, 'reports.hour', 0, 23); reports.groups = ids(reports.groups, 'reports.groups');
  if (reports.groups.some(id => !access.groups.includes(id))) fail('reports.groups');
  for (const [key, field] of Object.entries(paths)) {
    string(field, `paths.${key}`);
    if (field && ((!isAbsolute(field) && !win32.isAbsolute(field)) || field.split(/[\\/]/).includes('..'))) fail(`paths.${key}`);
  }
  bool(config.cache.enabled, 'cache.enabled');
  if (runtime.enabled && (!identity.ownerQQ || !identity.selfQQ || !connection.onebotWs || !connection.dshUrl || !paths.stateDir || !paths.workspace || !paths.dshHome)) fail('runtime.enabled');
  return config;
}
export function sanitizedConfig(config) {
  const result = structuredClone(config);
  for (const key of ['accessToken', 'wsAccessToken', 'dshToken']) {
    result.connection[`${key}Configured`] = Boolean(result.connection[key]);
    delete result.connection[key];
  }
  return result;
}
export function sanitizeValue(value, secrets = [], depth = 0) {
  if (depth > 12) return '[omitted]';
  if (typeof value === 'string') {
    let output = value;
    // Redact complete matches before shortening: shortening a long credential
    // first exposes its prefix and removes the complete match needed to redact.
    const ordered = [...secrets].filter(secret => typeof secret === 'string' && secret).sort((a, b) => b.length - a.length);
    for (const secret of ordered) output = output.split(secret).join('[redacted]');
    return output.slice(0, 4096);
  }
  if (value == null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map(entry => sanitizeValue(entry, secrets, depth + 1));
  if (!plain(value)) return undefined;
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (unsafe.has(key) || /token|secret|password|credential|authorization|cookie|api.?key/i.test(key)) continue;
    const safeKey = sanitizeValue(key, secrets, depth + 1);
    if (unsafe.has(safeKey)) continue;
    result[safeKey] = sanitizeValue(entry, secrets, depth + 1);
  }
  return result;
}
