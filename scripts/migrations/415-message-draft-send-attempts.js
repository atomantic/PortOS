/**
 * Add machine-local send audit fields without changing content or deciding
 * delivery. Boot recovery marks orphaned sending attempts delivery_unknown.
 */
import { join } from 'path';
import { writeJsonAtomic } from './_lib.js';
import { readJSONFileStrict } from '../../server/lib/fileUtils.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'messages', 'drafts.json');
    const { ok, value: drafts } = await readJSONFileStrict(file, null, { logError: false });
    if (ok && drafts === null) return { updated: 0 };
    if (!ok || !Array.isArray(drafts) || drafts.some(d => !d || typeof d !== 'object' || Array.isArray(d))) {
      throw new Error('Invalid message drafts snapshot; preserving original data');
    }
    let updated = 0;
    for (const draft of drafts) {
      if (Object.hasOwn(draft, 'sendAttempts') && Object.hasOwn(draft, 'sendAttemptId')) continue;
      draft.sendAttempts ??= [];
      draft.sendAttemptId ??= null;
      updated++;
    }
    if (updated) await writeJsonAtomic(file, drafts);
    return { updated };
  }
};
