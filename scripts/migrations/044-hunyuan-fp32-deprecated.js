/**
 * Pin HunyuanVideo to fp32 + mark it deprecated on the macOS video catalog.
 *
 * `scripts/generate_hunyuan.py` previously defaulted to fp16, which silently
 * trips an MPS matmul assertion ("Destination NDArray and Accumulator NDArray
 * cannot have different datatype") within ~2s of the first forward pass.
 * Verified empirically that bf16 hits the same assertion — only fp32 across
 * DiT + VAE + both text encoders works on Apple Silicon. At 576×1024×121
 * frames × 30 steps that's a 4-8 hr render, so on top of the dtype pin we
 * also flag the model `deprecated: true` so it moves to the "Legacy" optgroup
 * in the model picker (out of the default flow, still selectable if a user
 * wants to run it overnight).
 *
 * `data.reference/media-models.json` now carries `precision: 'fp32'` +
 * `deprecated: true` on the `hunyuan_video` entry plus an updated name that
 * surfaces the constraint. Fresh installs pick this up via setup-data.js,
 * but `media-models.json` is in the gitignored `data/` tree and is not in
 * JSON_MERGE_TARGETS — so existing installs keep their pre-flip entry and
 * crash on the next HunyuanVideo render. This migration patches the three
 * fields onto an unmodified `hunyuan_video` entry without touching anything
 * else.
 *
 * Idempotent: a second run finds the fields already present, or finds a
 * user-customized entry (precision pinned to a different dtype, name
 * changed) and exits without writing.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const REL_PATH = 'data/media-models.json';

// The exact pre-change name from data.reference. We only auto-rename when the
// stored name still matches this — a user who renamed the entry keeps theirs.
const OLD_SHIPPED_NAME = 'HunyuanVideo (13B, ~60 GB — swap text encoder to 4-bit Gemma)';
const NEW_SHIPPED_NAME = 'HunyuanVideo (13B — fp32-only on MPS, ~4-8 hr per render)';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh install will copy from data.reference)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    const macos = Array.isArray(config?.video?.macos) ? config.video.macos : null;
    if (!macos) {
      console.log(`⚠️ ${REL_PATH}: no video.macos[] array — skipping`);
      return;
    }

    const entry = macos.find((m) => m?.id === 'hunyuan_video');
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no 'hunyuan_video' entry — user removed it, nothing to migrate`);
      return;
    }

    let changed = false;
    if (entry.precision == null) {
      // Only set when absent. A user who pinned a non-fp32 dtype is opting
      // into the broken path knowingly (e.g. to retest after an Apple MPS
      // fix); don't overwrite their choice.
      entry.precision = 'fp32';
      changed = true;
    }
    if (entry.deprecated !== true) {
      entry.deprecated = true;
      changed = true;
    }
    if (entry.name === OLD_SHIPPED_NAME) {
      entry.name = NEW_SHIPPED_NAME;
      changed = true;
    }

    if (changed) {
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: pinned HunyuanVideo to fp32 + marked deprecated (MPS matmul fp16/bf16 broken)`);
    } else {
      console.log(`✅ ${REL_PATH}: HunyuanVideo entry already pinned to fp32 + deprecated, no changes`);
    }
  },
};
