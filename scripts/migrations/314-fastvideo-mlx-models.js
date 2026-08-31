/**
 * Add the FastVideo FastMetal MLX models (1.3B, 5B, 14B) to existing macOS
 * video registries. Fresh installs receive them from data.reference/media-models.json.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';

const NEW_ENTRIES = [
  {
    id: 'fastmetal_1_3b_qad',
    name: 'FastMetal 1.3B QAD (~3.5 GB download, 8+ GB RAM, 3-step)',
    repo: 'FastVideo/FastMetal-1.3B-QAD',
    runtime: 'fastvideo',
    supportedModes: ['text'],
    defaultWidth: 832,
    defaultHeight: 480,
    defaultFrames: 81,
    memoryGb: 8,
    steps: 3,
    guidance: 1,
    samplerLocked: true,
    samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
  },
  {
    id: 'fastmetal_5b_qad',
    name: 'FastMetal 5B QAD (~10 GB download, 16+ GB RAM, 3-step)',
    repo: 'FastVideo/FastMetal-5B-QAD',
    runtime: 'fastvideo',
    supportedModes: ['text'],
    defaultWidth: 1280,
    defaultHeight: 720,
    defaultFrames: 81,
    memoryGb: 16,
    steps: 3,
    guidance: 1,
    samplerLocked: true,
    samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
  },
  {
    id: 'fastmetal_14b_qad',
    name: 'FastMetal 14B QAD (~25 GB download, 36+ GB RAM, 3-step)',
    repo: 'FastVideo/FastMetal-14B-QAD',
    runtime: 'fastvideo',
    supportedModes: ['text'],
    defaultWidth: 1280,
    defaultHeight: 720,
    defaultFrames: 81,
    memoryGb: 36,
    steps: 3,
    guidance: 1,
    samplerLocked: true,
    samplerNote: 'FastMetal models are DMD2-distilled 3-step models with affine INT8 quantization.',
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
      console.log(`📝 ${REL_PATH}: added FastVideo FastMetal MLX models`);
    }
  },
};
