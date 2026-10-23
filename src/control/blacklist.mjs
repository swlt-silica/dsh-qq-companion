import { ControlError, assertManagement, assertBlockTarget, validateQQ, sanitizeValue } from './config.mjs';

// The worker's existing database is authoritative. No blacklist config is saved here.
export function createBlacklistAdapter({ request, getConfig, audit = async () => {} }) {
  return {
    async list(principal) { assertManagement(principal); return sanitizeValue(await request('blacklist.list', {})); },
    async add(userId, principal, reason = '') {
      assertManagement(principal); assertBlockTarget(getConfig(), userId);
      if (typeof reason !== 'string' || reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(reason))
        throw new ControlError('VALIDATION', 'Invalid blacklist reason');
      const result = await request('blacklist.add', { userId, reason });
      await audit('blacklist.add', { target: userId }, principal);
      return sanitizeValue(result);
    },
    async release(userId, principal) {
      assertManagement(principal); validateQQ(userId);
      const result = await request('blacklist.release', { userId });
      await audit('blacklist.release', { target: userId }, principal);
      return sanitizeValue(result);
    },
  };
}
