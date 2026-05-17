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
 * Update flow ordering caveat (Copilot review on PR #265): `setup-data.js`
 * runs *before* migrations, and its `JSON_MERGE_TARGETS` merges any new
 * sample stage entries that the install is missing — so by the time this
 * migration runs, an existing install will typically have BOTH keys:
 *   • `writers-room-settings` → the user's (possibly customized) entry
 *   • `writers-room-places`   → freshly auto-seeded from data.sample defaults
 * Naively keeping the auto-seeded `…-places` entry would silently discard
 * any model/provider/variable customizations the user had on `…-settings`.
 *
 * Resolution: when both keys are present, compare the installed
 * `writers-room-places` against the sample default. If it matches exactly,
 * it's the auto-seeded one and we replace it with the user's legacy entry
 * (preserving customizations). If it differs, the user hand-edited it on
 * purpose and we keep it as-is.
 *
 * Idempotent: skips when only `writers-room-places` is present (and no
 * legacy key), or when neither key exists (fresh installs get the
 * post-rename sample copy).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const STAGE_CONFIG_REL_PATH = 'data/prompts/stage-config.json';
const SAMPLE_CONFIG_REL_PATH = 'data.sample/prompts/stage-config.json';
const LEGACY_KEY = 'writers-room-settings';
const NEW_KEY = 'writers-room-places';

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

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

    if (!stages[LEGACY_KEY]) {
      console.log(`✅ ${STAGE_CONFIG_REL_PATH}: already on ${NEW_KEY}, no changes`);
      return;
    }

    // When both keys are present, decide which value to keep. The most
    // common case on `npm run setup && npm run migrations` flow is that
    // setup-data just auto-seeded `writers-room-places` with sample
    // defaults — in that case we must prefer the user's legacy entry so
    // their customizations survive.
    let prefersLegacyValue = true;
    if (stages[NEW_KEY]) {
      const sample = await readJsonOrNull(join(rootDir, SAMPLE_CONFIG_REL_PATH));
      const sampleEntry = sample?.stages?.[NEW_KEY];
      if (sampleEntry && JSON.stringify(stages[NEW_KEY]) === JSON.stringify(sampleEntry)) {
        // Installed `…-places` is byte-for-byte the sample default → it
        // was just auto-seeded by setup-data.js. Replace with the user's
        // legacy entry.
        prefersLegacyValue = true;
      } else {
        // User has hand-customized `…-places` (or sample lookup failed).
        // Respect that and discard the legacy entry.
        prefersLegacyValue = false;
      }
    }

    // Preserve order: walk keys and emit a fresh stages object with the
    // renamed key in the same slot the legacy key occupied. When both
    // keys exist and we're keeping the user's `…-places` entry, drop the
    // legacy slot entirely (the existing `…-places` slot stays in place).
    const renamed = {};
    for (const [key, value] of Object.entries(stages)) {
      if (key === LEGACY_KEY) {
        if (stages[NEW_KEY] && !prefersLegacyValue) continue;
        renamed[NEW_KEY] = value;
      } else if (key === NEW_KEY) {
        if (prefersLegacyValue && stages[LEGACY_KEY]) continue;
        renamed[NEW_KEY] = value;
      } else {
        renamed[key] = value;
      }
    }
    config.stages = renamed;

    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    if (stages[NEW_KEY] && prefersLegacyValue) {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: replaced auto-seeded ${NEW_KEY} with legacy ${LEGACY_KEY} entry (preserving user customizations)`);
    } else if (stages[NEW_KEY] && !prefersLegacyValue) {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: discarded legacy ${LEGACY_KEY} (user-customized ${NEW_KEY} already present)`);
    } else {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: renamed ${LEGACY_KEY} → ${NEW_KEY}`);
    }
  },
};
