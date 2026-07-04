/**
 * Backfill a spaced-repetition schedule on POST memory items that predate the
 * feature (issue #1991).
 *
 * Background:
 *   Memory items in `data/meatspace/post-memory-items.json` gained a review
 *   schedule — `{ ease, intervalDays, nextReview, lastReviewed }` — so items
 *   resurface on a due-today cadence (see `meatspacePostMemory.js`). New items
 *   get one at creation and the service backfills a default on read, but a
 *   persisted default keeps the on-disk record honest (and lets cross-machine
 *   sync carry the schedule). This migration stamps a default schedule — due
 *   NOW (intervalDays 0) — on every item that lacks one.
 *
 *   The built-in Elements Song is re-seeded on read, so a missing file is a
 *   clean no-op (the service adds a schedule when the file is first written).
 *   Re-runs detect the schedule is present and skip. A user (or the service)
 *   who already advanced an item's schedule is never clobbered.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// Mirror `meatspacePostMemory.DEFAULT_EASE` — the migration test asserts parity
// so a drift fails CI rather than shipping two different defaults.
export const MIGRATION_DEFAULT_EASE = 2.5;

const REL_PATH = 'data/meatspace/post-memory-items.json';

const hasSchedule = (item) =>
  item && typeof item.schedule === 'object' && item.schedule !== null
  && typeof item.schedule.nextReview === 'string';

export default {
  async up({ rootDir }) {
    const itemsPath = join(rootDir, REL_PATH);
    const raw = await readFile(itemsPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh installs seed the schedule on first write)`);
      return { updated: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return { updated: 0, reason: 'invalid-json' };
    }

    const items = Array.isArray(data?.items) ? data.items : null;
    if (!items) {
      console.log(`⚠️ ${REL_PATH}: no items array — skipping`);
      return { updated: 0, reason: 'no-items' };
    }

    const now = new Date().toISOString();
    let updated = 0;
    for (const item of items) {
      if (hasSchedule(item)) continue;
      // Anchor "due now" to the item's own timestamp when available (stable and
      // in the past → due), else the migration run time.
      const anchor = item?.updatedAt || item?.createdAt || now;
      item.schedule = { ease: MIGRATION_DEFAULT_EASE, intervalDays: 0, nextReview: anchor, lastReviewed: null };
      updated++;
    }

    if (updated === 0) {
      console.log(`✅ ${REL_PATH}: all ${items.length} memory item(s) already scheduled — no changes`);
      return { updated: 0, reason: 'already-scheduled' };
    }

    await writeFile(itemsPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: backfilled review schedule on ${updated}/${items.length} memory item(s)`);
    return { updated };
  },
};
