/**
 * Seed the `pipeline-comic-page-refine-render` stage into existing installs.
 *
 * Mirrors `091-seed-image-prompt-stages.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`.
 *
 * Why this exists: the prompt ships in `data.reference/` and is wired to the
 * comic-page "Refine" action (`refineComicPageRender` in
 * `server/services/pipeline/visualStages.js`, issue #1534). Boot runs migrations
 * (server/index.js) but NOT `setup-data.js`, so an install that upgrades by
 * pulling + `pm2 restart` (rather than running `update.sh`) would never receive
 * it — `buildPrompt('pipeline-comic-page-refine-render')` then throws "Stage not
 * found" the first time the user clicks "Refine".
 *
 * First-shipment seed: copy only when the file is missing (never clobber a
 * customized install) and merge the stage-config key only when absent. No MD5
 * hashing — there is no prior shipped-via-migration baseline to upgrade from.
 * NOTE: a FUTURE edit to the `.md` must add `ACCEPTED_OLD_MD5` / `NEW_SHIPPED_MD5`
 * exports (see migration 003) so `setup-data.js`'s `buildPromptDriftTables`
 * sweep can auto-update other installs.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const FILENAME = 'pipeline-comic-page-refine-render.md';
const STAGE_KEY = 'pipeline-comic-page-refine-render';

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1) Seed the `.md` template when missing.
    const dataPath = join(stagesDir, FILENAME);
    const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', FILENAME);
    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log(`📝 comic-page refine stage: ${FILENAME} already present`);
    } else {
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  comic-page refine stage: sample missing for ${FILENAME} — skipping copy`);
      } else {
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${FILENAME}`);
        } catch (err) {
          console.warn(`⚠️  comic-page refine stage: copy failed for ${FILENAME}: ${err.message}`);
        }
      }
    }

    // 2) Merge the stage-config entry when absent.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  comic-page refine stage: data.reference stage-config.json missing — cannot resolve entry; skipping config write');
      return;
    }
    try {
      const sample = JSON.parse(await readFile(sampleConfigPath, 'utf8'));
      const installedExists = await access(installedConfigPath, constants.F_OK).then(() => true, () => false);
      const installed = installedExists
        ? JSON.parse(await readFile(installedConfigPath, 'utf8'))
        : { stages: {} };
      installed.stages = installed.stages || {};

      if (installed.stages[STAGE_KEY]) {
        console.log(`📝 comic-page refine stage-config: ${STAGE_KEY} already present`);
        return;
      }
      if (!sample?.stages?.[STAGE_KEY]) {
        console.warn(`⚠️  comic-page refine stage: sample stage-config missing ${STAGE_KEY} — skipping`);
        return;
      }
      installed.stages[STAGE_KEY] = sample.stages[STAGE_KEY];
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 comic-page refine stage-config (${action}): ${STAGE_KEY} added`);
    } catch (err) {
      console.warn(`⚠️  comic-page refine stage: stage-config merge failed: ${err.message}`);
    }
  },
};
