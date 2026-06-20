/**
 * Seed the `pipeline-comic-panel-image-prompt` and
 * `pipeline-storyboard-image-prompt` stages into existing installs.
 *
 * Mirrors `090-script-verify-stage.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`.
 *
 * Why this exists: both prompts ship in `data.reference/` and are wired to the
 * comic-panel / storyboard "AI: refine" buttons (`refineComicPanelPrompt` /
 * `refineStoryboardScenePrompt` in `server/services/pipeline/visualStages.js`),
 * but they were added before this migration without a seed step. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an install that
 * upgrades by pulling + `pm2 restart` (rather than running `update.sh`) never
 * received them — `buildPrompt('pipeline-comic-panel-image-prompt')` then throws
 * "Stage not found" the first time the user clicks "AI: refine".
 *
 * First-shipment seed: copy only when the file is missing (never clobber a
 * customized install) and merge each stage-config key only when absent. No MD5
 * hashing — there is no prior shipped-via-migration baseline to upgrade from.
 * NOTE: a FUTURE edit to either `.md` must add `ACCEPTED_OLD_MD5` /
 * `NEW_SHIPPED_MD5` exports (see migration 003) so `setup-data.js`'s
 * `buildPromptDriftTables` sweep can auto-update other installs.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const STAGES = [
  { filename: 'pipeline-comic-panel-image-prompt.md', stageKey: 'pipeline-comic-panel-image-prompt' },
  { filename: 'pipeline-storyboard-image-prompt.md', stageKey: 'pipeline-storyboard-image-prompt' },
];

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1) Seed each `.md` template when missing.
    for (const { filename } of STAGES) {
      const dataPath = join(stagesDir, filename);
      const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);

      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 image-prompt stages: ${filename} already present`);
        continue;
      }
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  image-prompt stages: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  image-prompt stages: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2) Merge each stage-config entry when absent.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  image-prompt stages: data.reference stage-config.json missing — cannot resolve entries; skipping config write');
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
      for (const { stageKey } of STAGES) {
        if (installed.stages[stageKey]) {
          console.log(`📝 image-prompt stage-config: ${stageKey} already present`);
          continue;
        }
        if (!sample?.stages?.[stageKey]) {
          console.warn(`⚠️  image-prompt stages: sample stage-config missing ${stageKey} — skipping`);
          continue;
        }
        installed.stages[stageKey] = sample.stages[stageKey];
        added += 1;
      }

      if (added === 0) return;
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 image-prompt stage-config (${action}): ${added} added`);
    } catch (err) {
      console.warn(`⚠️  image-prompt stages: stage-config merge failed: ${err.message}`);
    }
  },
};
