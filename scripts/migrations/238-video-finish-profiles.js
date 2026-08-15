/**
 * Attach draft → delivery `finishModelId` edges to shipped video models
 * (issue #3696) in existing installs.
 *
 * `data.reference/media-models.json` ships the edge for fresh installs and
 * `mediaModels.js` backfills it at load — but `data/media-models.json` is the
 * gitignored, user-editable copy that is never merge-updated, so this migration
 * makes the change durable on disk instead of relying on the in-memory backfill
 * running every boot.
 *
 * Preservation contract (identical to `applyVideoFinishProfiles`):
 *   - an entry that already has a `finishModelId` key is left alone (user edit,
 *     including an explicit `null` meaning "no delivery target")
 *   - an id the user deleted is NOT recreated
 *   - a custom / user-added model is untouched (no shipped pair exists for it)
 *   - an entry whose `repo` was re-pointed at a fork is skipped — a pair
 *     established against upstream weights must not be claimed for a fork
 *   - entry order is preserved; nothing else on the entry is modified
 *
 * An edge whose target the user already deleted from their registry is dropped
 * again here rather than written out — the same thing `sanitizeFinishProfiles`
 * does at load, so disk and memory agree.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { applyVideoFinishProfiles, sanitizeFinishProfiles } from '../../server/lib/videoFinishProfiles.js';
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

    // Additive only: we count (and write) entries that GAINED an edge, never
    // entries the sanitizer merely stripped. So a draft whose delivery model
    // the user already deleted is left exactly as it was rather than rewritten,
    // and a hand-edited bad edge is left for the load-time sanitizer to warn
    // about instead of being silently deleted from the user's file here.
    let linked = 0;
    for (const platform of BUCKET_KEYS) {
      const list = config.video[platform];
      if (!Array.isArray(list)) continue;
      const next = sanitizeFinishProfiles(applyVideoFinishProfiles(list));
      const merged = list.map((entry, i) => {
        const gained = next[i]?.finishModelId && !(entry && 'finishModelId' in entry);
        if (!gained) return entry;
        linked += 1;
        return next[i];
      });
      config.video[platform] = merged;
    }

    if (linked > 0) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: linked ${linked} video ${linked === 1 ? 'entry' : 'entries'} to a Finish delivery model`);
    }
  },
};
