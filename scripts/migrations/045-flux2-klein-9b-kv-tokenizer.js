/**
 * Pin flux2-klein-9b's tokenizerRepo to the KV repo so multi-reference editing
 * loads without an extra HF license step.
 *
 * scripts/flux2_macos.py now branches into `Flux2KleinKVPipeline` when the
 * route forwards reference images, and the runner probes HF auth against the
 * configured `tokenizerRepo`. Pinning the SDNQ 9B entry to
 * `black-forest-labs/FLUX.2-klein-9B-kv` (same Qwen3 tokenizer as the base 9B
 * repo) means a user who accepts that one license can use both single-image
 * and multi-reference renders on this model.
 *
 * `data.reference/media-models.json` ships the new value for fresh installs,
 * but `data/media-models.json` is in the gitignored data/ tree and is NOT in
 * JSON_MERGE_TARGETS, so existing installs keep the old tokenizerRepo. This
 * migration swaps the pinned value when (and only when) it still matches the
 * pre-change shipped string — a user who pointed at a fork keeps their pin.
 *
 * Idempotent: a second run finds the new value (or a custom one) and exits
 * without writing.
 */

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { join } from 'path';

const REL_PATH = 'data/media-models.json';

const OLD_TOKENIZER_REPO = 'black-forest-labs/FLUX.2-klein-9B';
const NEW_TOKENIZER_REPO = 'black-forest-labs/FLUX.2-klein-9B-kv';

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

    const image = Array.isArray(config?.image) ? config.image : null;
    if (!image) {
      console.log(`⚠️ ${REL_PATH}: no image[] array — skipping`);
      return;
    }

    const entry = image.find((m) => m?.id === 'flux2-klein-9b');
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no 'flux2-klein-9b' entry — user removed it, nothing to migrate`);
      return;
    }

    if (entry.tokenizerRepo === OLD_TOKENIZER_REPO) {
      entry.tokenizerRepo = NEW_TOKENIZER_REPO;
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: pinned flux2-klein-9b tokenizerRepo → ${NEW_TOKENIZER_REPO} (enables multi-reference editing)`);
    } else {
      console.log(`✅ ${REL_PATH}: flux2-klein-9b tokenizerRepo is "${entry.tokenizerRepo}" (not the pre-change default) — leaving alone`);
    }
  },
};
