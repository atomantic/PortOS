/**
 * Seed the `craft-anti-patterns` prompt PARTIAL into existing installs (v2.27.0 —
 * CWQE craft-knowledge prompt upgrades, #2172).
 *
 * Migration `166-craft-knowledge-prompt-upgrades.js` injects a `{{> craft-anti-patterns }}`
 * reference into un-customized installs' `pipeline-prose.md` (and `181` into
 * `writers-room-continue.md`), but assumed `setup-data.js` would copy the NEW
 * partial file itself on the next boot. Boot runs migrations, NOT `setup-data.js`,
 * so on an upgrade that pulls + `pm2 restart`s (rather than running `update.sh`)
 * the reference lands with no partial on disk, and rendering the prose or
 * Writers-Room-continue stage throws `Prompt partial not found: "craft-anti-patterns"`
 * (`server/lib/promptPartials.js` — partials resolve strictly from
 * `data/prompts/_partials/`, with no `data.reference` fallback). Core drafting is a
 * hard throw, not an opt-in feature, so this seed is release-blocking.
 *
 * Mirrors the stage-seed family (`_seedStageHelpers.js`) but for the `_partials/`
 * directory, which that helper doesn't cover. Runs AFTER 166/181 within a single
 * boot's migration pass (filename sort), so the partial exists before any render.
 * Customization-safe + idempotent: copied only when missing, never clobbering a
 * hand-edited partial.
 */

import { access, copyFile, mkdir, constants } from 'fs/promises';
import { join } from 'path';

const PARTIAL_FILENAME = 'craft-anti-patterns.md';

export default {
  async up({ rootDir }) {
    const partialsDir = join(rootDir, 'data', 'prompts', '_partials');
    const dataPath = join(partialsDir, PARTIAL_FILENAME);
    const samplePath = join(rootDir, 'data.reference', 'prompts', '_partials', PARTIAL_FILENAME);

    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log('📝 craft-anti-patterns partial: already present');
      return;
    }
    const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
    if (!sampleExists) {
      console.warn(`⚠️  craft-anti-patterns: sample missing for ${PARTIAL_FILENAME} — skipping copy`);
      return;
    }
    await mkdir(partialsDir, { recursive: true });
    try {
      await copyFile(samplePath, dataPath);
      console.log(`✅ seeded ${PARTIAL_FILENAME}`);
    } catch (err) {
      console.warn(`⚠️  craft-anti-patterns: copy failed for ${PARTIAL_FILENAME}: ${err.message}`);
    }
  },
};
