/**
 * Add the FastH3 Preview v1 Dense / Data-Free MLX INT4 model to existing macOS
 * video registries (#5860). Fresh installs receive it from
 * data.reference/media-models.json.
 *
 * Same shape as migration 314 (FastMetal): the entry rides the existing
 * `fastvideo` BYOV runtime rather than introducing one, and `fastvideoFamily`
 * is what selects the FastH3 entry script inside that runtime.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';

const NEW_ENTRIES = [
  {
    id: 'fasth3_dense_datafree_mlx_int4',
    name: 'FastH3 Preview v1 Dense Data-Free MLX INT4 (video + audio, ~89 GB download, 36+ GB RAM, 4-step)',
    repo: 'MrMofer/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree-MLX-INT4',
    revision: '4c8c3e54da8cd667b5db10f6074b4cb9b7559f15',
    runtime: 'fastvideo',
    fastvideoFamily: 'fasth3',
    supportedModes: ['text'],
    defaultWidth: 832,
    defaultHeight: 480,
    defaultFrames: 124,
    // H3's video VAE decodes only 17n+5 frame counts, and FastH3 is a distilled
    // H3. Inlined rather than imported from lib/mediaModels.js: a migration must
    // keep writing the values it shipped with, not whatever the live registry
    // constant becomes three releases later.
    frameOptions: [107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362],
    fpsOptions: [24],
    resolutionStep: 32,
    resolutionOptions: [
      { label: '832x480 (16:9 FastH3 default)', w: 832, h: 480 },
      { label: '1280x720 (16:9 HD)', w: 1280, h: 720 },
    ],
    memoryGb: 36,
    steps: 4,
    guidance: 1,
    samplerLocked: true,
    samplerNote: 'FastH3 Preview v1 is a 4-step DMD2 model. This export is dense-attention only — it does not support VSA. Renders video with audio at a fixed 24 fps.',
    supportsNegativePrompt: false,
    supportsTiling: false,
    supportsDisableAudio: false,
  },
];

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
    const mlxEntries = readVideoBucket(config?.video, VIDEO_BUCKET_MLX);
    if (!Array.isArray(mlxEntries)) return;

    let changed = false;
    const present = new Set(mlxEntries.map((entry) => entry?.id));
    for (const entry of NEW_ENTRIES) {
      if (present.has(entry.id)) continue;
      mlxEntries.push(structuredClone(entry));
      present.add(entry.id);
      changed = true;
    }
    const shipped = readVideoBucket(config?._shippedDefaults?.video, VIDEO_BUCKET_MLX);
    if (Array.isArray(shipped)) {
      for (const entry of NEW_ENTRIES) {
        if (!shipped.includes(entry.id)) {
          shipped.push(entry.id);
          changed = true;
        }
      }
    }
    if (changed) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: added FastH3 Dense Data-Free MLX model`);
    }
  },
};
