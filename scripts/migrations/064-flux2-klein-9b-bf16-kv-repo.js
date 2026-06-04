/**
 * Add `kvRepo` to the flux2-klein-9b-bf16 entry so bf16 multi-reference editing
 * loads the `-kv` sibling repo (whose transformer is tuned for the reference-
 * editing task) instead of the base FLUX.2-klein-9B.
 *
 * scripts/flux2_macos.py now lifts the multi-reference gate on the bf16
 * (`quantization=none`) path and loads `--kv-repo` when reference images are
 * present; server/services/imageGen/local.js threads `model.kvRepo` through as
 * `--kv-repo`. Without this field the runner refuses bf16 reference renders.
 *
 * `data.reference/media-models.json` ships the new value for fresh installs,
 * and server/lib/mediaModels.js `backfillKvRepo` fills it at load — but a
 * migration makes the change durable in `data/media-models.json` (gitignored,
 * NOT in JSON_MERGE_TARGETS) so it survives even if the load-time backfill is
 * ever removed. This migration adds the field only when it's absent and the
 * `repo` still matches the pre-change shipped base repo — a user who pointed
 * the entry at a fork keeps their config untouched.
 *
 * Idempotent: a second run finds `kvRepo` already present and exits without
 * writing.
 */

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { join } from 'path';

const REL_PATH = 'data/media-models.json';

const ENTRY_ID = 'flux2-klein-9b-bf16';
const SHIPPED_REPO = 'black-forest-labs/FLUX.2-klein-9B';
const KV_REPO = 'black-forest-labs/FLUX.2-klein-9B-kv';

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

    const entry = image.find((m) => m?.id === ENTRY_ID);
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no '${ENTRY_ID}' entry — user removed it, nothing to migrate`);
      return;
    }

    if ('kvRepo' in entry) {
      console.log(`✅ ${REL_PATH}: ${ENTRY_ID} already has kvRepo="${entry.kvRepo}" — leaving alone`);
      return;
    }

    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ ${REL_PATH}: ${ENTRY_ID} repo is "${entry.repo}" (not the pre-change default) — leaving alone`);
      return;
    }

    entry.kvRepo = KV_REPO;
    await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${REL_PATH}: set ${ENTRY_ID} kvRepo → ${KV_REPO} (enables bf16 multi-reference editing)`);
  },
};
