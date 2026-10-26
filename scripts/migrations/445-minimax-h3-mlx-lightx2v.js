import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';
import profile from '../../server/lib/minimaxH3Lightx2vMlx.json' with { type: 'json' };

// Add only the pinned shipped MLX INT8 row's optional profile. Explicit null/[]
// overrides, custom rows, deleted rows, settings, and stock sampler stay intact.
export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data/media-models.json');
    const doc = await readJsonOrNull(path);
    if (!doc?.video || typeof doc.video !== 'object') return;
    let changed = false;
    for (const entries of Object.values(doc.video)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || 'speedProfiles' in entry
          || !Object.entries(profile.model).every(([key, value]) => entry[key] === value)
          || !isDeepStrictEqual(entry.requiredWeights, [profile.checkpoint])) continue;
        entry.speedProfiles = [structuredClone(profile)];
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(path, doc);
  },
};
