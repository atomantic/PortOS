/**
 * Attach `memoryProfiles` to the shipped MiniMax H3 entries (issue #5420) in
 * existing installs.
 *
 * `data.reference/media-models.json` ships the table for fresh installs and
 * `mediaModels.js` backfills it at load — but `data/media-models.json` is the
 * gitignored, user-editable copy that is never merge-updated, so this migration
 * makes the change durable on disk instead of relying on the in-memory backfill
 * running every boot. Same arrangement as migration 295 (speed profiles), 237
 * (disclosures) and 238 (Finish edges).
 *
 * Preservation contract (identical to `applyMiniMaxH3MemoryProfiles`):
 *   - an entry that already has a `memoryProfiles` key is left alone (user
 *     edit, including an explicit `null` / `[]`)
 *   - an id the user deleted is NOT recreated
 *   - a custom / user-added model is untouched (no shipped table exists)
 *   - an entry whose `repo` OR `revision` was re-pointed is skipped — a
 *     capacity claim must not be made for weights we did not validate against
 *   - entry order is preserved; nothing else on the entry is modified
 *
 * Additive only: an entry the sanitizer merely STRIPPED is never rewritten, so
 * a hand-edited bad table is left for the load-time sanitizer to warn about
 * rather than being silently deleted from the user's file here.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { applyMiniMaxH3MemoryProfiles } from '../../server/lib/minimaxH3Memory.js';
import { LEGACY_VIDEO_BUCKET_KEYS, VIDEO_BUCKETS } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';
// Both the canonical (#4142) and the legacy bucket spellings — an install that
// predates the rename can still be on either shape. Only keys actually holding
// an array are touched, so listing all four is safe on both.
const BUCKET_KEYS = [...VIDEO_BUCKETS, ...Object.values(LEGACY_VIDEO_BUCKET_KEYS)];

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return;
    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Cannot migrate ${REL_PATH}: invalid JSON (${err.message})`, { cause: err });
    }
    if (!config?.video || typeof config.video !== 'object') return;

    let profiled = 0;
    for (const platform of BUCKET_KEYS) {
      const list = config.video[platform];
      if (!Array.isArray(list)) continue;
      const next = applyMiniMaxH3MemoryProfiles(list);
      config.video[platform] = list.map((entry, i) => {
        const gained = Array.isArray(next[i]?.memoryProfiles) && !(entry && 'memoryProfiles' in entry);
        if (!gained) return entry;
        profiled += 1;
        return next[i];
      });
    }

    if (profiled > 0) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: attached memory profiles to ${profiled} video ${profiled === 1 ? 'entry' : 'entries'}`);
    }
  },
};
