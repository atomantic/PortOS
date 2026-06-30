/**
 * Seed the interiority-balance editorial-check stage into existing installs
 * (#1623).
 *
 * Mirrors `107-editorial-sensory-grounding-stages.js` (single stage instead of
 * two): copies the `.md` template from `data.reference/prompts/stages/` and
 * merges its stage-config entry into `data/prompts/stage-config.json`. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that pulls
 * + `pm2 restart`s (rather than running `update.sh`) would otherwise leave the
 * stage unseeded and the `scene.interiority-balance` editorial check would throw
 * "Stage not found" the first time it runs.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const STAGES = [
  'pipeline-editorial-interiority-balance',
];

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1) Copy each prompt template if it isn't already present.
    for (const stageKey of STAGES) {
      const filename = `${stageKey}.md`;
      const dataPath = join(stagesDir, filename);
      const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);

      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 ${stageKey} prompt: already present`);
        continue;
      }
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  ${stageKey}: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  ${stageKey}: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2) Merge each stage-config entry (skip any already present).
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  142-editorial-interiority-balance-stage: data.reference stage-config.json missing — cannot resolve entries; skipping config write');
      return;
    }
    try {
      const sample = JSON.parse(await readFile(sampleConfigPath, 'utf8'));
      const installedExists = await access(installedConfigPath, constants.F_OK).then(() => true, () => false);
      const installed = installedExists
        ? JSON.parse(await readFile(installedConfigPath, 'utf8'))
        : { stages: {} };
      installed.stages = installed.stages || {};

      let added = 0;
      for (const stageKey of STAGES) {
        if (installed.stages[stageKey]) {
          console.log(`📝 ${stageKey} stage-config: already present`);
          continue;
        }
        if (!sample?.stages?.[stageKey]) {
          console.warn(`⚠️  142-editorial-interiority-balance-stage: sample stage-config missing ${stageKey} — skipping`);
          continue;
        }
        installed.stages[stageKey] = sample.stages[stageKey];
        added += 1;
      }

      if (added === 0) {
        console.log('📝 142-editorial-interiority-balance-stage: no stage-config entries to add');
        return;
      }
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 142-editorial-interiority-balance-stage stage-config (${action}): ${added} added`);
    } catch (err) {
      console.warn(`⚠️  142-editorial-interiority-balance-stage: stage-config merge failed: ${err.message}`);
    }
  },
};
