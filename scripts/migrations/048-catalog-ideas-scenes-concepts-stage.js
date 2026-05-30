/**
 * Seed the `catalog-ideas-scenes-concepts` prompt stage into existing installs.
 *
 * Mirrors 043-story-builder-prompts.js — copies the `.md` template from
 * `data.reference/prompts/stages/` and merges the stage-config entry into
 * `data/prompts/stage-config.json`. Boot runs migrations (server/index.js)
 * BEFORE the AI toolkit reads stage-config.json, but does NOT run
 * `setup-data.js`. Without this migration, an upgrade that pulls main and
 * `pm2 restart`s (rather than running `update.sh`) leaves the new stage
 * unregistered — catalog ingest's light pass would throw "Stage
 * catalog-ideas-scenes-concepts not found" while the three bible passes
 * succeed, leaving the Ingest UI with a red failed row and no idea / scene /
 * concept candidates to review.
 */

import { access, copyFile, mkdir, readFile, constants } from 'fs/promises';
import { dirname, join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const STAGES = ['catalog-ideas-scenes-concepts'];

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1. Copy any missing prompt templates.
    for (const key of STAGES) {
      const filename = `${key}.md`;
      const dataPath = join(stagesDir, filename);
      const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);
      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 catalog ingest prompt: ${filename} already present`);
        continue;
      }
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  catalog ingest: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  catalog ingest: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2. Merge missing stage-config entries.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  catalog ingest: data.reference stage-config.json missing — skipping config write');
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
      for (const key of STAGES) {
        if (installed.stages[key]) continue;
        if (!sample?.stages?.[key]) {
          console.warn(`⚠️  catalog ingest: sample stage-config missing ${key} — skipping`);
          continue;
        }
        installed.stages[key] = sample.stages[key];
        added += 1;
      }
      if (added === 0) {
        console.log('📝 catalog ingest stage-config: all entries already present');
        return;
      }
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await atomicWrite(installedConfigPath, `${JSON.stringify(installed, null, 2)}\n`);
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 catalog ingest stage-config (${action}): ${added} added`);
    } catch (err) {
      console.warn(`⚠️  catalog ingest: stage-config merge failed: ${err.message}`);
    }
  },
};
