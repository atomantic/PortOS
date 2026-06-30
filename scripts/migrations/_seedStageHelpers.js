/**
 * Shared scaffolding for first-shipment "seed a pipeline stage" migrations (#1838).
 *
 * Companion to `./_lib.js` (hash-driven prompt-*replace*) — this one covers the
 * *seed-a-brand-new-stage* family: ~44 near-identical migrations (e.g.
 * `130-editorial-character-consistency-stage.js`) that each
 *   1) copy a `.md` template from `data.reference/prompts/stages/` into
 *      `data/prompts/stages/` when missing (never clobbering a customized file), and
 *   2) merge the matching `stage-config.json` entry into the installed config
 *      when absent (never clobbering an existing entry).
 *
 * Boot runs migrations (`server/index.js`) but NOT `setup-data.js`, so an upgrade
 * that pulls + `pm2 restart`s (rather than running `update.sh`) would otherwise
 * leave a newly-shipped stage unseeded and the dependent check would throw
 * "Stage not found" the first time it runs.
 *
 * `makeSeedMigration(stageKey, { filename })` returns the `{ up }` object every
 * such migration exports as its default. The runner (`scripts/run-migrations.js`)
 * only ever calls `up()` and tracks applied migrations by filename — there is no
 * rollback path, so no `down()` is emitted (it would be never-invoked dead code).
 * The runner skips `_`-prefixed files, so this module is never imported as a
 * migration. `filename` defaults to `${stageKey}.md` (the universal convention
 * across every seed migration); pass it only for the rare template whose basename
 * diverges from its stage key.
 *
 * The data effects above are what these migrations are responsible for — the
 * console log copy is incidental and not preserved verbatim from the pre-refactor
 * files (all now log under `stageKey`).
 */

import { access, copyFile, mkdir, readFile, constants } from 'fs/promises';
import { join } from 'path';

import { atomicWrite } from '../../server/lib/fileUtils.js';

/**
 * @param {string} stageKey  - stage-config key, e.g. `pipeline-editorial-character-consistency`
 * @param {{ filename?: string }} [opts] - template basename under `prompts/stages/` (defaults to `${stageKey}.md`)
 * @returns {{ up: (ctx: { rootDir: string }) => Promise<void> }}
 */
export function makeSeedMigration(stageKey, { filename = `${stageKey}.md` } = {}) {
  return {
    async up({ rootDir }) {
      const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
      await mkdir(stagesDir, { recursive: true });

      const dataPath = join(stagesDir, filename);
      const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);

      const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
      if (exists) {
        console.log(`📝 ${stageKey} prompt: already present`);
      } else {
        const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
        if (!sampleExists) {
          console.warn(`⚠️  ${stageKey}: sample missing for ${filename} — skipping copy`);
        } else {
          try {
            await copyFile(samplePath, dataPath);
            console.log(`✅ seeded ${filename}`);
          } catch (err) {
            console.warn(`⚠️  ${stageKey}: copy failed for ${filename}: ${err.message}`);
          }
        }
      }

      const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
      const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
      const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
      if (!sampleConfigExists) {
        console.warn(`⚠️  ${stageKey}: data.reference stage-config.json missing — cannot resolve entry; skipping config write`);
        return;
      }
      try {
        const sample = JSON.parse(await readFile(sampleConfigPath, 'utf8'));
        const installedExists = await access(installedConfigPath, constants.F_OK).then(() => true, () => false);
        const installed = installedExists
          ? JSON.parse(await readFile(installedConfigPath, 'utf8'))
          : { stages: {} };
        installed.stages = installed.stages || {};
        if (installed.stages[stageKey]) {
          console.log(`📝 ${stageKey} stage-config: already present`);
          return;
        }
        if (!sample?.stages?.[stageKey]) {
          console.warn(`⚠️  ${stageKey}: sample stage-config missing ${stageKey} — skipping`);
          return;
        }
        installed.stages[stageKey] = sample.stages[stageKey];
        // Canonical atomic write (temp + rename) so an interrupted boot/upgrade
        // can't leave a truncated stage-config.json; atomicWrite ensures the dir.
        await atomicWrite(installedConfigPath, `${JSON.stringify(installed, null, 2)}\n`);
        const action = installedExists ? 'merged' : 'created';
        console.log(`📝 ${stageKey} stage-config (${action}): 1 added`);
      } catch (err) {
        console.warn(`⚠️  ${stageKey}: stage-config merge failed: ${err.message}`);
      }
    },
  };
}
