/**
 * Rename the video registry's two buckets from `macos` / `windows` to `mlx` / `cuda` (issue #4142), along with `defaultMacos` / `defaultWindows` and the `_shippedDefaults.video` snapshot arrays.
 *
 * The OS names were never the real axis (the runtime family each entry needs, Apple MLX vs torch+CUDA, is): keying on the OS served a Linux install the MLX list, none of which runs there, while the two CUDA entries that would run sat in an unreachable `windows` list.
 * A pure rename (every value moves untouched), only so a hand-edited registry ends up with one spelling per bucket. NOT the compatibility mechanism: `server/lib/mediaModelBuckets.js` resolves either spelling on every read, so an install that never runs this (or a peer on an older release writing the file back) keeps working. `data.reference/media-models.json` ships the canonical keys, so a fresh install has nothing to do.
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
