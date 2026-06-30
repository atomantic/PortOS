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
 * `makeSeedMigrations(stageSpecs)` is the multi-stage form: it runs the same
 * copy-if-missing + merge-if-absent body for each stage but writes the installed
 * `stage-config.json` exactly once with an `N added` summary log. It is behaviour-
 * identical to the hand-rolled `for (const stageKey of STAGES)` loops the genuine
 * multi-stage seed migrations (091/094/095/107) used to carry — the on-disk
 * results (templates copied only when missing, config entries merged only when
 * absent, single pretty-printed write) match byte-for-byte. Each spec is either a
 * bare `stageKey` string (filename derived as `${stageKey}.md`) or a
 * `{ stageKey, filename }` object for the rare diverging basename. `makeSeedMigration`
 * is the single-stage convenience wrapper over the same machinery.
 *
 * The data effects above are what these migrations are responsible for — the
 * console log copy is incidental and not preserved verbatim from the pre-refactor
 * files (all now log under `stageKey`).
 */

import { access, copyFile, mkdir, readFile, constants } from 'fs/promises';
import { join } from 'path';

import { atomicWrite } from '../../server/lib/fileUtils.js';

/**
 * Normalize a stage spec (bare `stageKey` string or `{ stageKey, filename }`)
 * into `{ stageKey, filename }` with the universal `${stageKey}.md` default.
 * @param {string | { stageKey: string, filename?: string }} spec
 * @returns {{ stageKey: string, filename: string }}
 */
function normalizeStageSpec(spec) {
  if (typeof spec === 'string') return { stageKey: spec, filename: `${spec}.md` };
  const { stageKey, filename } = spec;
  return { stageKey, filename: filename || `${stageKey}.md` };
}

/**
 * Multi-stage seed migration: copy each `.md` template when missing and merge
 * each `stage-config.json` entry when absent, writing the installed config once
 * with an `N added` summary. Behaviour-identical to the hand-rolled
 * `for (const stageKey of STAGES)` loops it replaces.
 *
 * @param {Array<string | { stageKey: string, filename?: string }>} stageSpecs
 * @returns {{ up: (ctx: { rootDir: string }) => Promise<void> }}
 */
export function makeSeedMigrations(stageSpecs) {
  const stages = stageSpecs.map(normalizeStageSpec);
  return {
    async up({ rootDir }) {
      const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
      await mkdir(stagesDir, { recursive: true });

      // 1) Copy each prompt template that isn't already present.
      for (const { stageKey, filename } of stages) {
        const dataPath = join(stagesDir, filename);
        const samplePath = join(rootDir, 'data.reference', 'prompts', 'stages', filename);

        const exists = await access(dataPath, constants.F_OK).then(() => true, () => false);
        if (exists) {
          console.log(`📝 ${stageKey} prompt: already present`);
          continue;
        }
        const sampleExists = await access(samplePath, constants.F_OK).then(() => true, () => false);
        if (!sampleExists) {
          console.warn(`⚠️  ${stageKey}: sample missing for ${filename} — skipping copy`);
          continue;
        }
        try {
          await copyFile(samplePath, dataPath);
          console.log(`✅ seeded ${filename}`);
        } catch (err) {
          console.warn(`⚠️  ${stageKey}: copy failed for ${filename}: ${err.message}`);
        }
      }

      // 2) Merge each stage-config entry (skip any already present), writing once.
      const installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
      const sampleConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
      const sampleConfigExists = await access(sampleConfigPath, constants.F_OK).then(() => true, () => false);
      if (!sampleConfigExists) {
        console.warn('⚠️  seed-stages: data.reference stage-config.json missing — cannot resolve entries; skipping config write');
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
        for (const { stageKey } of stages) {
          if (installed.stages[stageKey]) {
            console.log(`📝 ${stageKey} stage-config: already present`);
            continue;
          }
          if (!sample?.stages?.[stageKey]) {
            console.warn(`⚠️  ${stageKey}: sample stage-config missing ${stageKey} — skipping`);
            continue;
          }
          installed.stages[stageKey] = sample.stages[stageKey];
          added += 1;
        }

        if (added === 0) return;
        // Canonical atomic write (temp + rename) so an interrupted boot/upgrade
        // can't leave a truncated stage-config.json; atomicWrite ensures the dir.
        await atomicWrite(installedConfigPath, `${JSON.stringify(installed, null, 2)}\n`);
        const action = installedExists ? 'merged' : 'created';
        console.log(`📝 seed-stages stage-config (${action}): ${added} added`);
      } catch (err) {
        console.warn(`⚠️  seed-stages: stage-config merge failed: ${err.message}`);
      }
    },
  };
}

/**
 * Single-stage convenience wrapper over {@link makeSeedMigrations}.
 * @param {string} stageKey  - stage-config key, e.g. `pipeline-editorial-character-consistency`
 * @param {{ filename?: string }} [opts] - template basename under `prompts/stages/` (defaults to `${stageKey}.md`)
 * @returns {{ up: (ctx: { rootDir: string }) => Promise<void> }}
 */
export function makeSeedMigration(stageKey, { filename = `${stageKey}.md` } = {}) {
  return makeSeedMigrations([{ stageKey, filename }]);
}
