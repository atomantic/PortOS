/**
 * Seed the `pipeline-canon-describe-from-prose` stage into existing installs.
 *
 * Mirrors `088-series-generate-stage.js`: copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new "Describe from prose"
 * Nouns-stage action unseeded and `buildPrompt('pipeline-canon-describe-from-prose')`
 * would throw "Stage not found" the first time a user clicks it.
 *
 * FIRST-SHIPMENT SEED ONLY — no MD5 hashing: it copies the template only when
 * missing and never overwrites an install's existing prompt. A FUTURE migration
 * that AMENDS this prompt must follow migration 003's hash-driven pattern
 * (normalize line endings, ship OLD + NEW shipped hashes) instead.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const FILENAME = 'pipeline-canon-describe-from-prose.md';
const STAGE_KEY = 'pipeline-canon-describe-from-prose';

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    const dataPath = join(stagesDir, FILENAME);
    const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', FILENAME);

    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log('📝 pipeline-canon-describe-from-prose prompt: already present');
    } else {
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  pipeline-canon-describe-from-prose: sample missing for ${FILENAME} — skipping copy`);
      } else {
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${FILENAME}`);
        } catch (err) {
          console.warn(`⚠️  pipeline-canon-describe-from-prose: copy failed for ${FILENAME}: ${err.message}`);
        }
      }
    }

    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  pipeline-canon-describe-from-prose: data.reference stage-config.json missing — cannot resolve entry; skipping config write');
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
        console.log('📝 pipeline-canon-describe-from-prose stage-config: already present');
        return;
      }
      if (!sample?.stages?.[STAGE_KEY]) {
        console.warn(`⚠️  pipeline-canon-describe-from-prose: sample stage-config missing ${STAGE_KEY} — skipping`);
        return;
      }
      installed.stages[STAGE_KEY] = sample.stages[STAGE_KEY];
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 pipeline-canon-describe-from-prose stage-config (${action}): 1 added`);
    } catch (err) {
      console.warn(`⚠️  pipeline-canon-describe-from-prose: stage-config merge failed: ${err.message}`);
    }
  },
};
