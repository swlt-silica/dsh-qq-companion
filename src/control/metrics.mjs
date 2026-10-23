import { ControlError, assertSafeObject } from './config.mjs';

export function emptyMetrics() {
  return { requests: 0, inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0, latencyMs: 0, cacheHitRate: 0 };
}
export function aggregateTokenMetrics(previous, usage) {
  assertSafeObject(usage, 'metrics');
  const keys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'latencyMs'];
  if (Object.keys(usage).some(key => !keys.includes(key))) throw new ControlError('VALIDATION', 'Unknown metric field');
  for (const key of keys) if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0))
    throw new ControlError('VALIDATION', 'Metrics must be non-negative safe integers');
  const result = { ...previous, requests: previous.requests + 1 };
  result.uncachedInputTokens += usage.inputTokens ?? 0;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'latencyMs']) result[key] += usage[key] ?? 0;
  result.inputTokens = result.uncachedInputTokens + result.cacheReadTokens + result.cacheWriteTokens;
  result.cacheHitRate = result.inputTokens ? result.cacheReadTokens / result.inputTokens : 0;
  if (Object.entries(result).some(([key, value]) => key !== 'cacheHitRate' && !Number.isSafeInteger(value)))
    throw new ControlError('VALIDATION', 'Metric total exceeds safe integer range');
  return result;
}
