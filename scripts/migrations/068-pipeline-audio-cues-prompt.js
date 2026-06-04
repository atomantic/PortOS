/**
 * Seed the whole-episode audio cue-planner prompt stage into existing installs
 * (issue #863, step 3 — docs/plans/2026-06-03-whole-episode-audio-strategy.md).
 *
 * Single-stage sibling of the writers-room prompt seeds (migration 065): copies
 * the `pipeline-audio-cues.md` template from `data.reference/prompts/stages/`
 * and merges its stage-config entry into `data/prompts/stage-config.json`. Boot
 * runs migrations (server/index.js) but NOT `setup-data.js`, so an upgrade that
 * pulls + `pm2 restart`s (rather than running the full setup) would otherwise
 * leave the new stage unseeded and the first POST .../cues/generate call would
 * throw "Stage not found".
 *
 * FIRST-SHIPMENT SEED ONLY — no MD5 hashing: it copies the template only when
 * missing and never overwrites an install's existing prompt. A FUTURE migration
 * that AMENDS this prompt must follow migration 003's hash-driven pattern
 * (normalize line endings, ship OLD + NEW shipped hashes) instead.
 */

import { access, copyFile, mkdir, readFile, constants } from 'fs/promises';
import { dirname, join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

// The prompt file's basename doubles as its stage-config key (sans `.md`).
const STAGE = 'pipeline-audio-cues';

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    // 1. Copy the prompt template if it's missing.
    const filename = `${STAGE}.md`;
    const dataPath = join(stagesDir, filename);
    const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);
    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log(`📝 audio-cues prompt: ${filename} already present`);
    } else {
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  audio-cues: sample missing for ${filename} — skipping copy`);
      } else {
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${filename}`);
        } catch (err) {
          console.warn(`⚠️  audio-cues: copy failed for ${filename}: ${err.message}`);
        }
      }
    }

    // 2. Merge the stage-config entry if it's missing.
    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  audio-cues: data.reference stage-config.json missing — skipping config write');
      return;
    }
    try {
      const sample = JSON.parse(await readFile(sampleConfigPath, 'utf8'));
      const installedExists = await access(installedConfigPath, constants.F_OK).then(() => true, () => false);
      const installed = installedExists
        ? JSON.parse(await readFile(installedConfigPath, 'utf8'))
        : { stages: {} };
      installed.stages = installed.stages || {};
      if (installed.stages[STAGE]) {
        console.log(`📝 audio-cues stage-config: ${STAGE} already present`);
        return;
      }
      if (!sample?.stages?.[STAGE]) {
        console.warn(`⚠️  audio-cues: sample stage-config missing ${STAGE} — skipping`);
        return;
      }
      installed.stages[STAGE] = sample.stages[STAGE];
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await atomicWrite(installedConfigPath, `${JSON.stringify(installed, null, 2)}\n`);
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 audio-cues stage-config (${action}): ${STAGE} added`);
    } catch (err) {
      console.warn(`⚠️  audio-cues: stage-config merge failed: ${err.message}`);
    }
  },
};
