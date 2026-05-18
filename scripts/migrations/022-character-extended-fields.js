/**
 * Universe canon characters — extended schema + reference-sheet assets.
 *
 * Schema extension itself is record-only: `sanitizeCharacter` in
 * `server/lib/storyBible.js` fills the new fields with defaults on next read,
 * so no on-disk character rewrite is required.
 *
 * Side effects this migration is responsible for (so an upgrade via plain
 * git-pull + pm2 restart, without re-running `npm run install:all` /
 * `scripts/setup-data.js`, still has everything the runtime expects):
 *
 *  1. Copies `data.sample/templates/character-reference-sheet.png` →
 *     `data/templates/character-reference-sheet.png` for the FLUX.2 init
 *     image anchor used by the reference-sheet renderer.
 *  2. Copies `data.sample/prompts/stages/universe-character-expand.md` →
 *     `data/prompts/stages/universe-character-expand.md` for the
 *     `expandUniverseCharacter` LLM stage.
 *  3. Merges the `universe-character-expand` entry into the installed
 *     `data/prompts/stage-config.json` so `runStagedLLM` can resolve the
 *     stage. Mirrors the pattern in `017-volume-cover-concepts-stage.js` /
 *     `020-comic-cover-concepts-stage.js`.
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const PROMPT_FILENAME = 'universe-character-expand.md';
const STAGE_KEY = 'universe-character-expand';
const TEMPLATE_FILENAME = 'character-reference-sheet.png';

export default {
  async up({ rootDir }) {
    // 1. Visual template asset — the reference-sheet renderer's init image.
    {
      const targetDir = join(rootDir, 'data', 'templates');
      const targetTemplate = join(targetDir, TEMPLATE_FILENAME);
      const sampleTemplate = join(rootDir, 'data.sample', 'templates', TEMPLATE_FILENAME);
      await mkdir(targetDir, { recursive: true });
      const exists = await access(targetTemplate, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 character-reference-sheet.png: already present`);
      } else {
        const sampleExists = await access(sampleTemplate, constants.F_OK).then(() => true, () => false);
        if (!sampleExists) {
          console.warn(`⚠️ character-reference-sheet.png: sample missing at ${sampleTemplate} — skipping`);
        } else {
          try {
            await copyFile(sampleTemplate, targetTemplate);
            console.log(`✅ seeded ${TEMPLATE_FILENAME}`);
          } catch (err) {
            console.warn(`⚠️ character-reference-sheet.png copy failed: ${err.message}`);
          }
        }
      }
    }

    // 2. LLM stage prompt.
    {
      const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
      await mkdir(stagesDir, { recursive: true });
      const dataPath = join(stagesDir, PROMPT_FILENAME);
      const samplePath = join(rootDir, 'data.sample', 'prompts', 'stages', PROMPT_FILENAME);
      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 ${PROMPT_FILENAME}: already present`);
      } else {
        const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
        if (!sampleExists) {
          console.warn(`⚠️ ${PROMPT_FILENAME}: sample missing — skipping copy`);
        } else {
          try {
            await copyFile(samplePath, dataPath);
            console.log(`✅ seeded ${PROMPT_FILENAME}`);
          } catch (err) {
            console.warn(`⚠️ ${PROMPT_FILENAME}: copy failed: ${err.message}`);
          }
        }
      }
    }

    // 3. stage-config entry — without this, runStagedLLM can't resolve the
    //    universe-character-expand stage and the expand route 500s.
    {
      const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
      const sampleConfigPath = join(rootDir, 'data.sample', 'prompts', 'stage-config.json');
      const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
      if (!sampleConfigExists) {
        console.warn(`⚠️ universe-character-expand: data.sample stage-config.json missing — skipping config write`);
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
          console.log(`📝 ${STAGE_KEY} stage-config: already present`);
          return;
        }
        if (!sample?.stages?.[STAGE_KEY]) {
          console.warn(`⚠️ ${STAGE_KEY}: sample stage-config missing the entry — skipping`);
          return;
        }
        installed.stages[STAGE_KEY] = sample.stages[STAGE_KEY];
        await mkdir(dirname(installedConfigPath), { recursive: true });
        await writeFile(installedConfigPath, JSON.stringify(installed, null, 2) + '\n', 'utf8');
        const action = installedExists ? 'merged' : 'created';
        console.log(`📝 ${STAGE_KEY} stage-config (${action}): 1 added`);
      } catch (err) {
        console.warn(`⚠️ ${STAGE_KEY}: stage-config merge failed: ${err.message}`);
      }
    }
  },
};
