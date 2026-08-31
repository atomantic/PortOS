/**
 * Retire the legacy HunyuanVideo MLX profile from existing registries.
 *
 * The shipped 13B checkpoint is fp32-only on MPS and takes roughly 4-8 hours
 * per render. HunyuanVideo 1.5 is a different CUDA runtime, not an upgrade the
 * pinned community MLX checkout can load. FastMetal is the supported native
 * Apple-Silicon replacement and its smallest profile covers the same text-only
 * workflow with a much lower memory and step count.
 *
 * Fresh installs receive the shorter catalog from data.reference. Existing
 * installs need this on-disk cleanup because their persisted registry is the
 * picker source of truth. mediaModels.js carries the matching load-time guard
 * so a registry cached before migrations run cannot write the retired row back.
 * A user-repointed entry is preserved as user configuration rather than being
 * mistaken for the shipped profile.
 */

import { VIDEO_BUCKET_MLX, resolveVideoDefaultKey } from '../../server/lib/mediaModelBuckets.js';
import { readMediaRegistry, writeMediaRegistry } from './_lib.js';

export const RETIRED_ID = 'hunyuan_video';
export const SHIPPED_REPO = 'tencent/HunyuanVideo';
export const REPLACEMENT_ID = 'fastmetal_1_3b_qad';

export default {
  async up({ rootDir }) {
    const { ok, config, entries: mlxEntries, bucketKey, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = mlxEntries.find((model) => model?.id === RETIRED_ID);
    if (!entry) {
      console.log(`✅ media-models: no '${RETIRED_ID}' entry — already retired, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ media-models: '${RETIRED_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    const kept = mlxEntries.filter((model) => model?.id !== RETIRED_ID);
    config.video[bucketKey] = kept;

    let defaultNote = '';
    const defaultKey = resolveVideoDefaultKey(config.video, VIDEO_BUCKET_MLX);
    if (defaultKey !== null
        && config.video[defaultKey] === RETIRED_ID
        && kept.some((model) => model?.id === REPLACEMENT_ID)) {
      config.video[defaultKey] = REPLACEMENT_ID;
      defaultNote = `; default video model → ${REPLACEMENT_ID}`;
    }

    await writeMediaRegistry(path, config);
    console.log(`📝 media-models: retired '${RETIRED_ID}' — use FastMetal instead${defaultNote}`);
  },
};
