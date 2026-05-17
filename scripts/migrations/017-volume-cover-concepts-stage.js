/**
 * Seed the `pipeline-volume-cover-concepts` stage into existing installs.
 *
 * Commit d802eb18 ("feat(pipeline): issue back covers + volume covers +
 * trade-paperback PDF") shipped the per-season cover-concept LLM step
 * (`arcPlanner.generateVolumeCoverConcepts` → `runStagedLLM('pipeline-volume-cover-concepts', …)`)
 * and added `data.sample/prompts/stages/pipeline-volume-cover-concepts.md`
 * but forgot two things existing installs need:
 *
 *   1. A `stage-config.json` entry — `setup-data.js` only merges
 *      `JSON_MERGE_TARGETS` on fresh setup, so existing installs that
 *      upgrade-and-restart never get the new entry and `prompts.getStage()`
 *      throws "Stage pipeline-volume-cover-concepts not found".
 *   2. The `.md` template — `ensureSampleContent` copies *missing* prompt
 *      files on next run so a fresh install gets it, but an upgrade that
 *      skips re-running setup-data leaves it absent.
 *
 * This migration fixes both for existing installs. Models on the same
 * idempotent pattern as `015-importer-stage-prompts.js`.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const FILENAME = 'pipeline-volume-cover-concepts.md';
const STAGE_KEY = 'pipeline-volume-cover-concepts';

export default {
  async up({ rootDir }) {
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    await mkdir(stagesDir, { recursive: true });

    const dataPath = join(stagesDir, FILENAME);
    const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', FILENAME);

    const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
    if (exists) {
      console.log(`📝 volume-cover-concepts prompt: already present`);
    } else {
      const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
      if (!sampleExists) {
        console.warn(`⚠️  volume-cover-concepts: sample missing for ${FILENAME} — skipping copy`);
      } else {
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${FILENAME}`);
        } catch (err) {
          console.warn(`⚠️  volume-cover-concepts: copy failed for ${FILENAME}: ${err.message}`);
        }
      }
    }

    const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const sampleConfigPath = join(rootDir, 'data.sample', 'prompts', 'stage-config.json');
    const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
    if (!sampleConfigExists) {
      console.warn('⚠️  volume-cover-concepts: data.sample stage-config.json missing — cannot resolve entry; skipping config write');
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
        console.log(`📝 volume-cover-concepts stage-config: already present`);
        return;
      }
      if (!sample?.stages?.[STAGE_KEY]) {
        console.warn(`⚠️  volume-cover-concepts: sample stage-config missing ${STAGE_KEY} — skipping`);
        return;
      }
      installed.stages[STAGE_KEY] = sample.stages[STAGE_KEY];
      await mkdir(dirname(installedConfigPath), { recursive: true });
      await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
      const action = installedExists ? 'merged' : 'created';
      console.log(`📝 volume-cover-concepts stage-config (${action}): 1 added`);
    } catch (err) {
      console.warn(`⚠️  volume-cover-concepts: stage-config merge failed: ${err.message}`);
    }
  },
};
