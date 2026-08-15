/**
 * Rename the video registry's two buckets from `macos` / `windows` to `mlx` /
 * `cuda` (issue #4142), along with `defaultMacos` / `defaultWindows` and the
 * `_shippedDefaults.video` snapshot arrays.
 *
 * The OS names were never the real axis. What separates the two lists is the
 * runtime family each entry needs — Apple MLX vs plain torch+CUDA — and reading
 * the OS off the key meant a Linux install was served the MLX list, none of
 * which runs there, while the two CUDA entries that would run sat in an
 * unreachable `windows` list.
 *
 * This is a pure rename: every value moves untouched, nothing is added, dropped,
 * or re-ordered within a bucket. It exists only so a registry a user hand-edits
 * ends up with a single spelling per bucket. It is NOT the compatibility
 * mechanism — `server/lib/mediaModelBuckets.js` resolves either spelling on
 * every read, so an install that never runs this migration (or a peer still on
 * an older release writing the file back) keeps working.
 *
 * `data.reference/media-models.json` ships the canonical keys, so a fresh
 * install has nothing to do here.
 */

import { canonicalizeVideoBuckets } from '../../server/lib/mediaModelBuckets.js';
import { readMediaRegistryConfig, writeMediaRegistry } from './_lib.js';

const REL_PATH = 'data/media-models.json';

export default {
  async up({ rootDir }) {
    const { ok, config, path } = await readMediaRegistryConfig({ rootDir });
    if (!ok) return;

    const video = canonicalizeVideoBuckets(config.video);
    // `_shippedDefaults.video` holds only the two id arrays — no default-model
    // keys — so the default-key half of the rename must not run against it.
    const shipped = canonicalizeVideoBuckets(config._shippedDefaults?.video, { defaultKeys: false });
    if (!video.changed && !shipped.changed) {
      console.log(`✅ ${REL_PATH}: video buckets already keyed mlx/cuda, nothing to migrate`);
      return;
    }

    if (video.changed) config.video = video.video;
    if (shipped.changed) config._shippedDefaults.video = shipped.video;

    await writeMediaRegistry(path, config);
    console.log(`📝 ${REL_PATH}: renamed the video buckets macos/windows → mlx/cuda`);
  },
};
