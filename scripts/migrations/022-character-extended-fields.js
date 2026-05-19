/**
 * Universe canon characters — extended schema + LLM expand stage assets.
 *
 * Schema extension itself is record-only: `sanitizeCharacter` in
 * `server/lib/storyBible.js` fills the new fields with defaults on next read,
 * so no on-disk character rewrite is required.
 *
 * Side effects this migration is responsible for (so an upgrade via plain
 * git-pull + pm2 restart, without re-running `npm run install:all` /
 * `scripts/setup-data.js`, still has everything the runtime expects):
 *
 *  1. Copies `data.sample/prompts/stages/universe-character-expand.md` →
 *     `data/prompts/stages/universe-character-expand.md` for the
 *     `expandUniverseCharacter` LLM stage.
 *  2. Merges the `universe-character-expand` entry into the installed
 *     `data/prompts/stage-config.json` so `runStagedLLM` can resolve the
 *     stage. Mirrors the pattern in `017-volume-cover-concepts-stage.js` /
 *     `020-comic-cover-concepts-stage.js`.
 *
 * Earlier versions of this migration also seeded
 * `data/templates/character-reference-sheet.png` as a FLUX.2 init image
 * for the sheet renderer. The renderer has since switched to a pure
 * text-template prompt that works across codex + local backends and no
 * longer consumes that asset — the seeding step was removed to stop
 * advertising a non-existent dependency to future maintainers. Already-
 * installed PNGs on existing systems are harmless (orphan file).
 */

import { access, copyFile, mkdir, readFile, writeFile, constants } from 'fs/promises';
import { dirname, join } from 'path';

const PROMPT_FILENAME = 'universe-character-expand.md';
const STAGE_KEY = 'universe-character-expand';

export default {
  async up({ rootDir }) {
    // 1. LLM stage prompt.
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

    // 2. stage-config entry — without this, runStagedLLM can't resolve the
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
