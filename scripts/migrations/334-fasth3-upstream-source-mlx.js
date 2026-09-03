/**
 * Add FastVideo's own FastH3 Dense / Data-Free snapshot to existing macOS video
 * registries, at all three MLX DiT formats. Fresh installs receive them from
 * data.reference/media-models.json.
 *
 * Migration 333 shipped a third-party repack because FastVideo's MLX repos
 * publish no weights (they still do not). These rows point at the upstream bf16
 * diffusers snapshot instead and declare `fastvideoMlxFormat`, which is what
 * makes the helper run FastVideo's own converter on the snapshot's transformer/
 * before the first render. One download serves all three rows.
 */

import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';
import { readMediaRegistry, writeMediaRegistry } from './_lib.js';

// H3's video VAE decodes only 17n+5 frame counts, and the MLX pipeline refuses
// anything outside 5-15 s at 24 fps, so the grid is 124..345. Inlined rather
// than imported from lib/mediaModels.js: a migration must keep writing the
// values it shipped with, not whatever the live constant becomes three releases
// later.
const FRAME_OPTIONS = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345];

// What migration 333 wrote. Its two extra ends — 107 (4.46 s) and 362 (15.08 s)
// — sit outside the pipeline's window and raise instead of rendering, so an
// install that already ran 333 carries a picker with a broken value at each end.
const MIGRATION_333_FRAME_OPTIONS = [107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362];
const REPACK_ID = 'fasth3_dense_datafree_mlx_int4';
const RESOLUTION_OPTIONS = [
  { label: '832x480 (16:9 FastH3 default)', w: 832, h: 480 },
  { label: '1280x720 (16:9 HD)', w: 1280, h: 720 },
];

const NEW_ENTRIES = [
  { format: 'int8', memoryGb: 48, label: 'INT8 (highest fidelity)' },
  { format: 'int6', memoryGb: 42, label: 'INT6 (upstream default)' },
  { format: 'int4', memoryGb: 36, label: 'INT4 (smallest)' },
].map(({ format, memoryGb, label }) => ({
  id: `fasth3_dense_datafree_${format}`,
  name: `FastH3 Preview v1 Dense Data-Free — MLX ${label} (video + audio, ~144 GB download, ${memoryGb}+ GB RAM, 4-step)`,
  repo: 'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
  revision: 'f624f08c6c279ab43534c003e556fc5b295b6558',
  runtime: 'fastvideo',
  fastvideoFamily: 'fasth3',
  fastvideoMlxFormat: format,
  supportedModes: ['text'],
  defaultWidth: 832,
  defaultHeight: 480,
  defaultFrames: 124,
  frameOptions: FRAME_OPTIONS,
  fpsOptions: [24],
  resolutionStep: 32,
  resolutionOptions: RESOLUTION_OPTIONS,
  memoryGb,
  steps: 4,
  guidance: 1,
  samplerLocked: true,
  samplerNote: `FastH3 Preview v1 is a 4-step DMD2 model. This is FastVideo's own dense-attention checkpoint — it does not support VSA, whose routing weights the MLX runtime drops. The first render converts its transformer to an MLX ${format.toUpperCase()} DiT (a few minutes, once), after which the 66 GB bf16 transformer can be deleted. Renders video with audio at a fixed 24 fps.`,
  supportsNegativePrompt: false,
  supportsTiling: false,
  supportsDisableAudio: false,
}));

export default {
  async up({ rootDir }) {
    const { ok, config, entries: mlxEntries, path } = await readMediaRegistry({ rootDir, bucket: VIDEO_BUCKET_MLX });
    if (!ok) return;

    let added = 0;
    let repaired = false;
    const present = new Set(mlxEntries.map((entry) => entry?.id));
    for (const entry of NEW_ENTRIES) {
      if (present.has(entry.id)) continue;
      mlxEntries.push(structuredClone(entry));
      present.add(entry.id);
      added += 1;
    }
    // Repair the row 333 shipped, but only while it still holds 333's exact
    // list — a user who edited their own frame options keeps them.
    const repack = mlxEntries.find((entry) => entry?.id === REPACK_ID);
    if (repack && Array.isArray(repack.frameOptions)
      && repack.frameOptions.length === MIGRATION_333_FRAME_OPTIONS.length
      && repack.frameOptions.every((frames, i) => frames === MIGRATION_333_FRAME_OPTIONS[i])) {
      repack.frameOptions = [...FRAME_OPTIONS];
      repaired = true;
    }

    const shipped = readVideoBucket(config?._shippedDefaults?.video, VIDEO_BUCKET_MLX);
    if (Array.isArray(shipped)) {
      for (const entry of NEW_ENTRIES) {
        if (!shipped.includes(entry.id)) {
          shipped.push(entry.id);
          added = Math.max(added, 1);
        }
      }
    }
    if (added > 0 || repaired) {
      await writeMediaRegistry(path, config);
      // Say which of the two things actually happened — an upgrade that only
      // repaired the frame grid did not add anything.
      const what = [
        added > 0 ? `added ${added} upstream FastH3 Dense Data-Free MLX model(s)` : null,
        repaired ? 'repaired the FastH3 repack frame options' : null,
      ].filter(Boolean).join('; ');
      console.log(`📝 data/media-models.json: ${what}`);
    }
  },
};
