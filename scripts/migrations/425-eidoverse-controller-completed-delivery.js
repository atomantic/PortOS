/**
 * Retain completed outbound delivery independently of latest-tick outcomes.
 * Older outcomes/proposal summaries cannot prove a completed acknowledgement,
 * so history starts unknown. Offline and provider-free; no derived-store seed.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'eidoverse', 'controllers.json');
    const raw = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0, reason: 'no-controller-store' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('⚠️ migration 425: unreadable controller store; leaving it untouched');
      return { updated: 0, reason: 'unreadable-store' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.installs || typeof parsed.installs !== 'object' || Array.isArray(parsed.installs)) {
      return { updated: 0, reason: 'invalid-store' };
    }
    if (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > 2) {
      return { updated: 0, reason: 'newer-schema' };
    }
    let updated = 0;
    for (const record of Object.values(parsed.installs)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      if (!Object.hasOwn(record, 'lastCompletedDelivery')) {
        record.lastCompletedDelivery = null;
        updated += 1;
      }
    }
    if (updated === 0 && parsed.schemaVersion === 2) return { updated: 0, reason: 'already-current' };
    await writeJsonAtomic(file, { ...parsed, schemaVersion: 2 });
    console.log(`🔁 migration 425: initialized unknown delivery history for ${updated} Eidoverse controller(s)`);
    return { updated, reason: 'upgraded' };
  },
};
