/**
 * Brain digests/reviews now require the `scheduledReviewsEnabled` opt-in.
 * Derives it from the install's own records: enabled only where at least one
 * stored digest or weekly review proves the user has been running them.
 * Gates on the presence of that input (never the absence of the output), so it
 * ships no data.reference seed.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

const hasRecords = async (path) => {
  const raw = await readFile(path, 'utf8').catch(err => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  return raw.trim().length > 0;
};

export default {
  async up({ rootDir }) {
    const dir = join(rootDir, 'data', 'brain');
    const ran = (await hasRecords(join(dir, 'digests.jsonl'))) || (await hasRecords(join(dir, 'reviews.jsonl')));
    if (!ran) return { enabled: false };

    const metaPath = join(dir, 'meta.json');
    const raw = await readFile(metaPath, 'utf8').catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    let meta = {};
    if (raw !== null) {
      try { meta = JSON.parse(raw); } catch { return { enabled: false, skipped: 'unreadable meta.json' }; }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { enabled: false, skipped: 'unexpected meta.json' };
    }
    if (typeof meta.scheduledReviewsEnabled === 'boolean') return { enabled: meta.scheduledReviewsEnabled };
    await writeJsonAtomic(metaPath, { ...meta, scheduledReviewsEnabled: true });
    return { enabled: true };
  }
};
