/**
 * Attach provenance/licensing disclosure metadata to shipped video models
 * (issue #3674) in existing installs.
 *
 * `data.reference/media-models.json` ships the new `disclosure` block for fresh
 * installs, and `mediaModels.js` backfills it at load — but `data/
 * media-models.json` is the gitignored, user-editable copy that is never
 * merge-updated, so this migration makes the change durable on disk instead of
 * relying on the in-memory backfill running every boot.
 *
 * Preservation contract (identical to `applyVideoDisclosures`):
 *   - an entry that already has a `disclosure` key is left alone (user edit)
 *   - an id the user deleted is NOT recreated
 *   - a custom / user-added model is untouched (no shipped facts exist for it)
 *   - an entry whose `repo` was re-pointed at a fork is skipped — upstream's
 *     license and download-size facts must not be attributed to a fork
 *   - entry order is preserved; nothing else on the entry is modified
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { applyVideoDisclosures } from '../../server/lib/videoDisclosure.js';
import { LEGACY_VIDEO_BUCKET_KEYS, VIDEO_BUCKETS } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';
// Both the canonical (#4142) and the legacy bucket spellings: this migration
// predates the rename and can meet either shape. Only keys actually holding an
// array are touched, so listing all four is safe on both.
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

    let enriched = 0;
    for (const platform of BUCKET_KEYS) {
      const list = config.video[platform];
      if (!Array.isArray(list)) continue;
      const next = applyVideoDisclosures(list);
      for (let i = 0; i < list.length; i += 1) {
        if (next[i] !== list[i]) enriched += 1;
      }
      config.video[platform] = next;
    }

    if (enriched > 0) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: added model disclosure metadata to ${enriched} video ${enriched === 1 ? 'entry' : 'entries'}`);
    }
  },
};
