/**
 * Seed the two `pipeline-beat-continuity` stages into existing installs (#1510).
 *
 * Mirrors `087-manuscript-reformat-stage.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges its stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js) but
 * NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new whole-manuscript
 * beat-continuity stages unseeded — and Series Autopilot, whose new
 * `maxBeatContinuityRounds` defaults > 0, would throw "Stage not found" the
 * first time it reached `runStagedLLM('pipeline-beat-continuity')`.
 *
 * Two stages this seeds (idempotent — a present file/entry is left as-is):
 *   - pipeline-beat-continuity          (the whole-book beat verify)
 *   - pipeline-beat-continuity-resolve  (the per-issue beat auto-resolve)
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const STAGE_KEYS = ['pipeline-beat-continuity', 'pipeline-beat-continuity-resolve'];

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1. Copy each missing prompt template.
    for (const key of STAGE_KEYS) {
      const filename = `${key}.md`;
      const dataPath = join(stagesDir, filename);
      const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);

      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 ${key} prompt: already present`);
        continue;
      }
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  beat-continuity: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  beat-continuity: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2. Merge each missing stage-config entry.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  beat-continuity: data.reference stage-config.json missing — cannot resolve entries; skipping config write');
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
      for (const key of STAGE_KEYS) {
        if (installed.stages[key]) {
          console.log(`📝 ${key} stage-config: already present`);
          continue;
        }
        if (!sample?.stages?.[key]) {
          console.warn(`⚠️  beat-continuity: sample stage-config missing ${key} — skipping`);
          continue;
        }
        installed.stages[key] = sample.stages[key];
        added += 1;
      }
      if (added === 0) return;

      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 beat-continuity stage-config (${action}): ${added} added`);
    } catch (err) {
      console.warn(`⚠️  beat-continuity: stage-config merge failed: ${err.message}`);
    }
  },
};
