/**
 * Seed the `pipeline-editorial-pacing-escalation-curve` stage into existing
 * installs (#1618).
 *
 * Mirrors `111-editorial-plot-structure-stage.js`: copies the `.md` template
 * from `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new pacing-escalation stage
 * unseeded and the `pacing.escalation-curve` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const FILENAME = 'pipeline-editorial-pacing-escalation-curve.md';
const STAGE_KEY = 'pipeline-editorial-pacing-escalation-curve';

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    const dataPath = join(stagesDir, FILENAME);
    const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', FILENAME);

    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log(`📝 pipeline-editorial-pacing-escalation-curve prompt: already present`);
    } else {
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  pipeline-editorial-pacing-escalation-curve: sample missing for ${FILENAME} — skipping copy`);
      } else {
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${FILENAME}`);
        } catch (err) {
          console.warn(`⚠️  pipeline-editorial-pacing-escalation-curve: copy failed for ${FILENAME}: ${err.message}`);
        }
      }
    }

    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  pipeline-editorial-pacing-escalation-curve: data.reference stage-config.json missing — cannot resolve entry; skipping config write');
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
        console.log(`📝 pipeline-editorial-pacing-escalation-curve stage-config: already present`);
        return;
      }
      if (!sample?.stages?.[STAGE_KEY]) {
        console.warn(`⚠️  pipeline-editorial-pacing-escalation-curve: sample stage-config missing ${STAGE_KEY} — skipping`);
        return;
      }
      installed.stages[STAGE_KEY] = sample.stages[STAGE_KEY];
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 pipeline-editorial-pacing-escalation-curve stage-config (${action}): 1 added`);
    } catch (err) {
      console.warn(`⚠️  pipeline-editorial-pacing-escalation-curve: stage-config merge failed: ${err.message}`);
    }
  },
};
