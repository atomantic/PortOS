/**
 * Retire the LTX-2 Unified video model from existing registries.
 *
 * `ltx2_unified` (notapalindrome/ltx2-mlx-av, ~42 GB) shipped `deprecated: true` once LTX-2.3 landed and is now removed: LTX-2.3 Unified Beta is the bf16 quality ceiling for the same `mlx_video` runtime and LTX-2.3 Distilled Q4 is smaller (~22 GB) and better, so keeping the 42 GB download only costs disk and render time.
 * `data/media-models.json` is gitignored runtime state and not a JSON_MERGE_TARGET: fresh installs get the shorter list from data.reference/media-models.json, existing ones need this patch (removing it from `DEFAULT_REGISTRY` alone isn't enough; `appendNewlyShippedEntries` never deletes).
 * This is the on-disk half; `RETIRED_VIDEO_MODELS` in `server/lib/mediaModels.js` is the load-time half that actually governs the pickers (the registry is cached at import, before this runs). They share constants (asserted in this migration's test) and the preservation rule: an entry re-pointed at a different `repo` is the user's model and survives.
 * The MLX bucket's default (`video.defaultMlx`, or pre-#4142 `defaultMacos`) is repointed at `ltx23_distilled_q4` only when the removal happened and that replacement is present (else `getDefaultVideoModelId()`'s fallback would land on the 48 GB Unified Beta).
 * `_shippedDefaults.video.mlx` keeps the id: it records what was ever delivered, nothing re-adds a model absent from `DEFAULT_REGISTRY`, and `warnDrift` ignores non-current ids.
 */

import { VIDEO_BUCKET_MLX, resolveVideoDefaultKey } from '../../server/lib/mediaModelBuckets.js';
import { readMediaRegistry, writeMediaRegistry } from './_lib.js';

export const RETIRED_ID = 'ltx2_unified';
export const SHIPPED_REPO = 'notapalindrome/ltx2-mlx-av';
export const REPLACEMENT_ID = 'ltx23_distilled_q4';

export default {
  async up({ rootDir }) {
    const { ok, config, entries: mlxEntries, bucketKey, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = mlxEntries.find((m) => m?.id === RETIRED_ID);
    if (!entry) {
      console.log(`✅ media-models: no '${RETIRED_ID}' entry — already retired, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ media-models: '${RETIRED_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    // Write back under the key the array was FOUND under (`mlx`, or the
    // pre-#4142 `macos` on a registry this install hasn't renamed yet) — writing
    // the canonical key unconditionally would leave the legacy array in place
    // and silently un-retire the model. Same for the default-model key.
    const kept = mlxEntries.filter((m) => m?.id !== RETIRED_ID);
    config.video[bucketKey] = kept;

    // When the replacement was deleted too, leave the MLX default pointing at
    // the retired id and let getDefaultVideoModelId() fall back to whatever this
    // install still has, rather than naming a model that isn't there.
    let defaultNote = '';
    const defaultKey = resolveVideoDefaultKey(config.video, VIDEO_BUCKET_MLX);
    if (defaultKey !== null
        && config.video[defaultKey] === RETIRED_ID
        && kept.some((m) => m?.id === REPLACEMENT_ID)) {
      config.video[defaultKey] = REPLACEMENT_ID;
      defaultNote = `; default video model → ${REPLACEMENT_ID}`;
    }

    await writeMediaRegistry(path, config);
    console.log(`📝 media-models: retired '${RETIRED_ID}' — superseded by LTX-2.3${defaultNote}`);
  },
};
