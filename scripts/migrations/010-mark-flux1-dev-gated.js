/**
 * Mark FLUX.1-dev as a gated HuggingFace model in existing installs.
 *
 * `data.sample/media-models.json` now carries `requiresHfToken: true` +
 * `licenseUrl` on the `dev` entry so the Image Gen page can surface the
 * inline HF-token banner (same pattern FLUX.2-klein already used). Fresh
 * installs pick this up via the data.sample → data copy in setup-data.js,
 * but `media-models.json` is not in JSON_MERGE_TARGETS so existing installs
 * keep their pre-flip entry. This migration patches the two fields onto an
 * unmodified `dev` entry without touching anything else.
 *
 * Idempotent: a second run finds either both fields already present, or a
 * user who customized/renamed the entry, and exits without writing.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const REL_PATH = 'data/media-models.json';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${REL_PATH} not present — skipping (fresh install will copy from data.sample)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    const images = Array.isArray(config?.image) ? config.image : null;
    if (!images) {
      console.log(`⚠️ ${REL_PATH}: no image[] array — skipping`);
      return;
    }

    const dev = images.find((m) => m?.id === 'dev');
    if (!dev) {
      console.log(`✅ ${REL_PATH}: no 'dev' entry — user removed it, nothing to migrate`);
      return;
    }

    let changed = false;
    if (dev.requiresHfToken !== true) {
      dev.requiresHfToken = true;
      changed = true;
    }
    if (!dev.licenseUrl) {
      dev.licenseUrl = 'https://huggingface.co/black-forest-labs/FLUX.1-dev';
      changed = true;
    }

    if (changed) {
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: marked FLUX.1-dev as gated (requiresHfToken + licenseUrl)`);
    } else {
      console.log(`✅ ${REL_PATH}: FLUX.1-dev already marked as gated, no changes`);
    }
  },
};
