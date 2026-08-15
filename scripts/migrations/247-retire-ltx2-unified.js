/**
 * Retire the LTX-2 Unified video model from existing registries.
 *
 * `ltx2_unified` (notapalindrome/ltx2-mlx-av, ~42 GB) shipped `deprecated: true`
 * once LTX-2.3 landed and is now removed outright: LTX-2.3 Unified Beta is the
 * bf16 quality ceiling for the same `mlx_video` runtime, and LTX-2.3 Distilled
 * Q4 is both smaller (~22 GB) and better than LTX-2 was. Keeping a strictly
 * worse 42 GB download in the picker only costs users disk and render time.
 *
 * `data/media-models.json` is gitignored runtime state and is not a
 * JSON_MERGE_TARGET, so a fresh install gets the shorter list from
 * data.reference/media-models.json while existing installs need this patch.
 * Removing the entry from `DEFAULT_REGISTRY` alone is NOT enough — the user's
 * persisted list is the source of truth for the picker, and
 * `appendNewlyShippedEntries` never deletes from it.
 *
 * This is the on-disk half of the retirement; `RETIRED_VIDEO_MODELS` in
 * `server/lib/mediaModels.js` is the load-time half, and it is the one that
 * actually governs what the pickers show — the registry is cached at import
 * time, before the runner reaches this migration. The two share the same
 * constants (asserted in this migration's test) and the same preservation rule:
 * an entry a user re-pointed at a different `repo` is their model, not the
 * retired built-in, and survives untouched.
 *
 * The MLX bucket's default (`video.defaultMlx`, or the pre-#4142
 * `defaultMacos`) is repointed at `ltx23_distilled_q4` only when the
 * removal actually happened and that replacement is present; otherwise
 * `getDefaultVideoModelId()`'s "unknown default → first available" fallback
 * would silently land on the 48 GB Unified Beta.
 *
 * `_shippedDefaults.video.mlx` intentionally keeps the id: it records what has
 * ever been delivered to this install, nothing re-adds a model that is no longer
 * in `DEFAULT_REGISTRY`, and `warnDrift` ignores ids that aren't current
 * built-ins, so no boot warning results.
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
