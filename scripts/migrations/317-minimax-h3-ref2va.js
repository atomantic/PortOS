/**
 * Add the MiniMax H3 Ref2VA MLX image+audio model to existing macOS video
 * registries. Fresh installs receive it from data.reference/media-models.json.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';

const REL_PATH = 'data/media-models.json';

export const MINIMAX_H3_REF2VA_ENTRY = Object.freeze({
  id: 'minimax_h3_ref2va_8bit',
  name: 'MiniMax H3 Ref2VA MLX 8-bit (image + arbitrary-length audio, ~71 GB, 128 GB RAM)',
  repo: 'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
  revision: '61dc387ef1a7166425cdacd63c2340598dcc364f',
  runtime: 'minimax_h3_ref2va',
  supportedModes: ['a2v'],
  requiresSourceImageForA2v: true,
  audioDurationDriven: true,
  arbitraryLengthAudio: true,
  maxReferenceAudioSeconds: 15,
  defaultFrames: 124,
  frameOptions: [107, 124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362],
  fpsOptions: [24],
  defaultWidth: 512,
  defaultHeight: 320,
  resolutionStep: 32,
  resolutionOptions: [
    { label: '512x320 (draft)', w: 512, h: 320 },
    { label: '768x480', w: 768, h: 480 },
    { label: '1024x640', w: 1024, h: 640 },
    { label: '768x768 (1:1)', w: 768, h: 768 },
  ],
  memoryGb: 128,
  steps: 9,
  guidance: 0,
  samplerLocked: true,
  samplerNote: 'MiniMax H3 Ref2VA is CFG-distilled. PortOS renders audio in up-to-15-second continuity-linked windows, then restores the exact source audio over the final video.',
  supportsNegativePrompt: false,
  supportsTiling: false,
  supportsDisableAudio: false,
});

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

    const shipped = readVideoBucket(config?._shippedDefaults?.video, VIDEO_BUCKET_MLX);
    const wasAlreadyShipped = Array.isArray(shipped)
      && shipped.includes(MINIMAX_H3_REF2VA_ENTRY.id);
    let present = mlxEntries.some((entry) => entry?.id === MINIMAX_H3_REF2VA_ENTRY.id);
    let changed = false;
    // A recorded-but-missing built-in is an intentional user deletion. This
    // matters when a lost/corrupt migrations ledger replays the migration:
    // never resurrect a model the install already received and removed.
    if (!present && !wasAlreadyShipped) {
      mlxEntries.push(structuredClone(MINIMAX_H3_REF2VA_ENTRY));
      present = true;
      changed = true;
    }
    if (Array.isArray(shipped) && present && !wasAlreadyShipped) {
      shipped.push(MINIMAX_H3_REF2VA_ENTRY.id);
      changed = true;
    }
    if (changed) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: added MiniMax H3 Ref2VA MLX model`);
    }
  },
};
