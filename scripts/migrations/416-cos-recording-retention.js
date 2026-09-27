/**
 * Adopt metadata-preserving CoS retention. No recordings are converted at
 * upgrade: bounded maintenance converts raw.txt to verified raw.txt.gz lazily.
 * Config is migration-owned and must not have a data.reference seed.
 */
import { join } from 'path';
import { readJSONFileStrict } from '../../server/lib/fileUtils.js';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'cos', 'config.json');
    const { ok, value } = await readJSONFileStrict(file, null, { logError: false });
    if (ok && value === null) return { updated: 0 };
    if (!ok || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CoS config; preserving original');
    if (Object.hasOwn(value, 'agentStorage')) return { updated: 0 };
    await writeJsonAtomic(file, { ...value, agentStorage: { autoCompress: true, compressAfterDays: 7, autoPurge: false, purgeAfterDays: 90 } });
    return { updated: 1 };
  },
};
