import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function envelope(fact) {
  if (!plain(fact)) throw new Error('Invalid fact');
  return {
    qqFactId: text(fact.qqFactId ?? fact.id ?? fact.factId, 'fact ID'),
    sourceKey: text(fact.sourceKey, 'source key'),
    subjectId: text(fact.subjectId, 'subject ID'),
    text: text(fact.text, 'fact text', 10_000),
  };
}
function childEnvironment() {
  const env = {};
  // Do not inherit model/provider credentials, proxies, NODE_OPTIONS or arbitrary plugin settings.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.MNEMON_MAX_INSIGHTS = '0';
  // Native 0.2.12 has no embedding-disable flag: this refuses only a local availability probe.
  // It does not contact any external provider and must not be described as zero network traffic.
  env.MNEMON_EMBED_ENDPOINT = 'http://127.0.0.1:9';
  env.MNEMON_EMBED_PROTOCOL = 'ollama';
  return env;
}

/** Synchronous secondary index. The caller's authorized SQL facts remain the authority.
 * `run` must have execFileSync's (binary, argv, options) => string/Buffer contract.
 * One writer process per dataDir is required; this JSON index is application data, not a backup.
 */
export function createNativeMemory({ binaryPath, dataDir, run = execFileSync } = {}) {
  if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath) || typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw new Error('Native paths must be absolute');
  if (typeof run !== 'function') throw new Error('Invalid Native runner');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const indexPath = join(dataDir, 'qq-native-index.json');
  const load = () => {
    if (!existsSync(indexPath)) return { version: 1, entries: {} };
    try {
      const value = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (!plain(value) || value.version !== 1 || !plain(value.entries)) throw new Error();
      for (const [key, item] of Object.entries(value.entries)) {
        if (!plain(item) || typeof item.nativeId !== 'string' || !item.nativeId || typeof item.envelopeHash !== 'string'
          || typeof item.sourceKey !== 'string' || typeof item.factId !== 'string' || key !== digest(JSON.stringify([item.sourceKey, item.factId]))) throw new Error();
      }
      return value;
    } catch { throw new Error('Native memory index is invalid'); }
  };
  load();
  const save = index => {
    const pendingPath = join(dataDir, `.qq-native-index-${randomUUID()}.tmp`);
    writeFileSync(pendingPath, JSON.stringify(index), { mode: 0o600, flag: 'wx' });
    renameSync(pendingPath, indexPath);
  };
  const keyFor = (sourceKey, factId) => digest(JSON.stringify([sourceKey, factId]));
  const invoke = (sourceKey, args) => {
    let output;
    try {
      output = run(binaryPath, ['--data-dir', dataDir, '--store', 'qq_' + digest(sourceKey), ...args], {
        shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
        encoding: 'utf8', env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { throw new Error('Native memory command failed'); }
    if (output && typeof output.then === 'function') throw new Error('Native runner must be synchronous');
    if (typeof output !== 'string' && !Buffer.isBuffer(output)) throw new Error('Invalid Native memory response');
    try { return JSON.parse(String(output)); } catch { throw new Error('Invalid Native memory response'); }
  };
  return Object.freeze({
    remember(fact) {
      const value = envelope(fact);
      const payload = JSON.stringify(value);
      const index = load();
      const key = keyFor(value.sourceKey, value.qqFactId);
      const existing = index.entries[key];
      if (existing !== undefined) {
        if (existing.envelopeHash !== digest(payload)) throw new Error('Fact changed; explicit replacement is required');
        return existing.nativeId;
      }
      const result = invoke(value.sourceKey, ['remember', payload, '--cat', fact.category === 'preference' ? 'preference' : 'general', '--imp', '3', '--entities', value.subjectId, '--source', 'user', '--no-diff']);
      if (!plain(result) || result.action !== 'added' || typeof result.id !== 'string' || !result.id
        || result.auto_pruned !== 0) throw new Error('Native memory write was not confirmed safely');
      index.entries[key] = { sourceKey: value.sourceKey, factId: value.qqFactId, nativeId: result.id, envelopeHash: digest(payload) };
      save(index);
      return result.id;
    },
    rank({ query, sourceKeys, allowedFactIds, limit = 6 } = {}) {
      try {
        text(query, 'query', 10_000);
        if (!Array.isArray(sourceKeys) || sourceKeys.length > 32 || !(Array.isArray(allowedFactIds) || allowedFactIds instanceof Set)
          || !Number.isInteger(limit) || limit < 1 || limit > 50) return [];
        const allowed = new Set([...allowedFactIds].map(id => text(id, 'allowed fact ID')));
        const sources = [...new Set(sourceKeys.map(source => text(source, 'source key')))];
        if (allowed.size === 0 || sources.length === 0) return [];
        const ranked = [];
        for (const sourceKey of sources) {
          const result = invoke(sourceKey, ['recall', query, '--verbose', '--limit', String(Math.min(50, Math.max(20, limit * 3)))]);
          const rows = Array.isArray(result) ? result : plain(result) && Array.isArray(result.results) ? result.results : undefined;
          if (rows === undefined) return [];
          for (const row of rows) {
            if (!plain(row)) return [];
            const insight = plain(row.insight) ? row.insight : row;
            if (typeof insight.content !== 'string') return [];
            let value;
            try { value = envelope(JSON.parse(insight.content)); } catch { continue; }
            if (value.sourceKey !== sourceKey || !allowed.has(value.qqFactId)) continue;
            // Unscored rows have a stable zero score; no raw memory content leaves this boundary.
            const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0;
            ranked.push({ id: value.qqFactId, score, order: ranked.length });
          }
        }
        ranked.sort((a, b) => b.score - a.score || a.order - b.order);
        return [...new Set(ranked.map(item => item.id))].slice(0, limit);
      } catch { return []; }
    },
    forget({ sourceKey, factId } = {}) {
      text(sourceKey, 'source key'); text(factId, 'fact ID');
      const index = load();
      const key = keyFor(sourceKey, factId);
      const item = index.entries[key];
      if (item === undefined) return false;
      const result = invoke(sourceKey, ['forget', item.nativeId]);
      if (!plain(result) || !['forgotten', 'deleted'].includes(result.status ?? result.action)) throw new Error('Native memory deletion was not confirmed');
      delete index.entries[key];
      save(index);
      return true;
    },
    status() { return { entries: Object.keys(load().entries).length, automaticPruning: false, embedding: 'local-refused-probe', synchronous: true }; },
    close() {},
  });
}
