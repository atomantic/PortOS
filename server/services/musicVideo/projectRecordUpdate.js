import { retainMusicVideoDependencies } from '../../lib/musicVideo/musicVideoDependencies.js';

/** Return the next record with `extra` merged and `updatedAt` freshly stamped. */
export function touchProjectRecord(record, extra) {
  return retainMusicVideoDependencies(record, { ...record, ...extra, updatedAt: new Date().toISOString() });
}
