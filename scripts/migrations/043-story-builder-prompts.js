/**
 * Seed the Unified Story Builder prompt stages into existing installs.
 *
 * Multi-file variant of `041-editorial-analysis-stage.js`: copies the three
 * `.md` templates from `data.reference/prompts/stages/` and merges their
 * stage-config entries into `data/prompts/stage-config.json`. Boot runs
 * migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that
 * pulls + `pm2 restart`s (rather than running `update.sh`) would otherwise
 * leave the new Story Builder stages unseeded and the first reader-map /
 * idea-expand generation would throw "Stage not found".
 *
 * FIRST-SHIPMENT SEED ONLY — no MD5 hashing here: it copies *missing*
 * templates and never overwrites an install's existing prompt. When a FUTURE
 * migration AMENDS any of these story-builder prompts, follow migration 003's
 * pattern instead: normalize line endings (\r\n → \n, bare \r → \n) before
 * hashing, and ship both the prior-shipped hash (OLD_SHIPPED_MD5 /
 * ACCEPTED_OLD_MD5) and the new one (NEW_SHIPPED_MD5) so unmodified installs
 * auto-update and customized ones warn instead of being clobbered.
 * See scripts/migrations/003-update-pipeline-stage-prompts.js.
 */

import { access, copyFile, mkdir, readFile, constants } from 'fs/promises';
import { dirname, join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

// Each prompt file's basename doubles as its stage-config key (sans `.md`).
const STAGES = [
  'story-builder-idea-expand',
  'story-builder-reader-map',
  'story-builder-reader-map-refine',
];

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
        console.log(`📝 story-builder prompt: ${filename} already present`);
        continue;
      }
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  story-builder: sample missing for ${filename} — skipping copy`);
        continue;
      }
      try {
        await copyFile(samplePath, dataPath);
        console.log(`✅ seeded ${filename}`);
      } catch (err) {
        console.warn(`⚠️  story-builder: copy failed for ${filename}: ${err.message}`);
      }
    }

    // 2. Merge any missing stage-config entries.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  story-builder: data.reference stage-config.json missing — skipping config write');
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
          console.warn(`⚠️  story-builder: sample stage-config missing ${key} — skipping`);
          continue;
        }
        installed.stages[key] = sample.stages[key];
        added += 1;
      }
      if (added === 0) {
        console.log('📝 story-builder stage-config: all entries already present');
        return;
      }
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await atomicWrite(installedConfigPath, `${JSON.stringify(installed, null, 2)}\n`);
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 story-builder stage-config (${action}): ${added} added`);
    } catch (err) {
      console.warn(`⚠️  story-builder: stage-config merge failed: ${err.message}`);
    }
  },
};
