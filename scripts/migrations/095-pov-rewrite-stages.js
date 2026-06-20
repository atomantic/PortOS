/**
 * Seed the `pipeline-pov-rewrite` + `pipeline-pov-analysis` stages into existing
 * installs (#1290 — "Rewrite a story in another character's POV + analyze").
 *
 * Mirrors `093-reverse-outline-stage.js`: copies each `.md` template from
 * `data.reference/prompts/stages/` and merges the matching stage-config entry
 * into `data/prompts/stage-config.json`. Boot runs migrations (server/index.js)
 * but NOT `setup-data.js`, so an upgrade that pulls + `pm2 restart`s (rather than
 * running `update.sh`) would otherwise leave the new POV stages unseeded and
 * `buildPrompt('pipeline-pov-rewrite')` would throw "Stage not found" the first
 * time a user runs a perspective rewrite.
 *
 * Two stages ship together (rewrite + analysis), so this loops over both rather
 * than the single-stage shape of 093.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const STAGE_KEYS = ['pipeline-pov-rewrite', 'pipeline-pov-analysis'];

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1. Copy each prompt template that isn't already present.
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
        console.warn(`⚠️  pov-rewrite: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  pov-rewrite: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2. Merge the stage-config entries.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  pov-rewrite: data.reference stage-config.json missing — cannot resolve entries; skipping config write');
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
          console.warn(`⚠️  pov-rewrite: sample stage-config missing ${key} — skipping`);
          continue;
        }
        installed.stages[key] = sample.stages[key];
        added += 1;
      }
      if (added > 0) {
        await mkdir(dirname(installedConfigPath), { recursive: true });
        await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
        const action = installedExists ? 'merged' : 'created';
        console.log(`📝 pov-rewrite stage-config (${action}): ${added} added`);
      }
    } catch (err) {
      console.warn(`⚠️  pov-rewrite: stage-config merge failed: ${err.message}`);
    }
  },
};
