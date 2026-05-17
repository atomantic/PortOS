/**
 * Rename the `writers-room-settings` stage key to `writers-room-places` in
 * the installed `data/prompts/stage-config.json`.
 *
 * Background: commit be903564 renamed the prompt file
 * `writers-room-settings.md` → `writers-room-places.md` (Universe rename PR)
 * but deferred the corresponding stage-key rename. Existing installs that
 * upgrade through this commit still have the old `writers-room-settings`
 * key in their config — at runtime the prompt service looks up
 * `data/prompts/stages/writers-room-settings.md`, finds nothing (the file
 * is now `…-places.md`), and throws `Template for writers-room-settings
 * not found`.
 *
 * Idempotent: skips when only `writers-room-places` is present, or when
 * neither key exists (fresh installs get the post-rename sample copy).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const STAGE_CONFIG_REL_PATH = 'data/prompts/stage-config.json';

export default {
  async up({ rootDir }) {
    const path = join(rootDir, STAGE_CONFIG_REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${STAGE_CONFIG_REL_PATH} not present — skipping (fresh install will copy from data.sample)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${STAGE_CONFIG_REL_PATH}: invalid JSON, skipping migration (${err.message})`);
      return;
    }

    const stages = config?.stages;
    if (!stages || typeof stages !== 'object') {
      console.log(`⚠️ ${STAGE_CONFIG_REL_PATH}: no stages map — skipping`);
      return;
    }

    if (!stages['writers-room-settings']) {
      console.log(`✅ ${STAGE_CONFIG_REL_PATH}: already on writers-room-places, no changes`);
      return;
    }

    // Preserve order: walk keys and emit a fresh stages object with the
    // renamed key in the same slot. If the user happens to also have a
    // hand-added `writers-room-places` entry, prefer the existing one and
    // discard the legacy key.
    const renamed = {};
    for (const [key, value] of Object.entries(stages)) {
      if (key === 'writers-room-settings') {
        if (stages['writers-room-places']) continue;
        renamed['writers-room-places'] = value;
      } else {
        renamed[key] = value;
      }
    }
    config.stages = renamed;

    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`📝 ${STAGE_CONFIG_REL_PATH}: renamed writers-room-settings → writers-room-places`);
  },
};
