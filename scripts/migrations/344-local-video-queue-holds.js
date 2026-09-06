/** Add local runtime holds without changing or re-enqueueing any stored job. */
import { join } from 'path';
import { writeJsonAtomic } from './_lib.js';
import { readJSONFileStrict } from '../../server/lib/fileUtils.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'media-jobs.json');
    const { ok, value: envelope } = await readJSONFileStrict(file, null, { logError: false });
    if (ok && envelope === null) return { updated: 0 };
    if (!ok || !Array.isArray(envelope?.jobs)) {
      console.warn('⚠️ data/media-jobs.json: unreadable or invalid queue snapshot; skipping hold migration and preserving the file');
      return { updated: 0 };
    }
    if (Object.hasOwn(envelope, 'videoHolds')) return { updated: 0 };
    await writeJsonAtomic(file, { ...envelope, videoHolds: [] });
    return { updated: 1 };
  },
};
