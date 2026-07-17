/**
 * Shared test scaffolding for `makeSeedMigrations`-based seed migrations (#2706).
 * Companion to `./_seedStageHelpers.js` — the seed-family analogue of
 * `./_testHelpers.js`'s `runPromptMigrationTests` (the hash-driven replace
 * family). The runner skips `_`-prefixed files, so this is never imported as a
 * migration.
 *
 * `_seedStageHelpers.test.js` already covers the seed *mechanics* against
 * synthetic stages (copy-if-missing, merge-if-absent, missing-sample tolerance,
 * single config write). What it cannot cover is each migration's own wiring:
 * that the specific stage ids it names seed correctly, and — most valuable —
 * that those ids' `data.reference/prompts/stages/*.md` templates and
 * `stage-config.json` entries actually ship. Without that guard, a future
 * reference-template rename/removal would surface only at runtime as
 * "Stage not found" on a fresh install, with no failing test.
 *
 * Per-migration `*.test.js` collapses to a `describe` + a single
 * `runSeedStageMigrationTests({ migration, stages, prefix })` call.
 *
 * Fixtures are built in an `mkdtempSync` sandbox seeded from copies of the live
 * `data.reference/` assets — the live tree is only ever READ, never written, and
 * the install's real `data/` tree is never touched.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { repoRoot, sampleBody } from './_testHelpers.js';
import { normalizeStageSpec } from './_seedStageHelpers.js';

const refStagePath = (filename) => join(repoRoot, 'data.reference', 'prompts', 'stages', filename);
const refConfigPath = () => join(repoRoot, 'data.reference', 'prompts', 'stage-config.json');

/** Live shipped template body, or `null` when the template no longer ships. */
const shippedBody = (filename) => (existsSync(refStagePath(filename)) ? sampleBody(filename) : null);

/** Live shipped stage-config, read fresh (never cached across suites). */
const shippedConfig = () => JSON.parse(readFileSync(refConfigPath(), 'utf-8'));

/**
 * Standard seed-migration suite: seeds-when-absent, no-op re-run, no-clobber,
 * and a data.reference drift catch.
 *
 * @param {object} opts
 * @param {{ up: (ctx: { rootDir: string }) => Promise<void>, stages: Array<object> }} opts.migration - the migration's default export
 * @param {Array<string | { stageKey: string, filename?: string }>} opts.stages - the stage specs the caller
 *   expects the migration to seed. Spelled out in the test for readability, then pinned to
 *   `migration.stages` by the first case below — so adding a stage to the migration without
 *   updating the test (or vice versa) fails loudly instead of leaving the suite asserting
 *   about a stale list.
 * @param {string} opts.prefix - `mkdtempSync` dir name; keep migration-specific (`'migration-189-'`)
 *   so a debugger leaves a recognizable sandbox in the temp dir
 */
export function runSeedStageMigrationTests({ migration, stages, prefix }) {
  const specs = stages.map(normalizeStageSpec);
  let rootDir;
  let stagesDir;
  let installedConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), prefix));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    const refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(refStagesDir, { recursive: true });

    // Mirror the REAL shipped assets into the sandbox so the seed assertions
    // exercise what actually ships rather than a synthetic stand-in. A missing
    // asset is tolerated here (not thrown) so the drift test below reports it
    // precisely instead of every case dying in setup with an ENOENT.
    const config = shippedConfig();
    const fixtureStages = {};
    for (const { stageKey, filename } of specs) {
      const body = shippedBody(filename);
      if (body !== null) writeFileSync(join(refStagesDir, filename), body);
      if (config.stages[stageKey]) fixtureStages[stageKey] = config.stages[stageKey];
    }
    writeFileSync(
      join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
      `${JSON.stringify({ stages: fixtureStages }, null, 2)}\n`,
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds exactly the stages this suite covers (no drift between test and migration)', () => {
    // Anchors every case below to the migration's REAL list. Without this, adding
    // a stage to the migration and forgetting to ship its template would leave the
    // whole suite green — it would still be asserting about the stale list here.
    expect(migration.stages).toEqual(specs);
  });

  it('seeds every template and stage-config entry on an install missing them', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();

    const config = shippedConfig();
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf-8'));
    for (const { stageKey, filename } of specs) {
      expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(shippedBody(filename));
      // toBeTruthy first: under partial drift both sides are `undefined` and a bare
      // toEqual would pass vacuously, reading like it checked the seeding.
      expect(config.stages[stageKey], `data.reference stage-config missing entry: ${stageKey}`).toBeTruthy();
      expect(installed.stages[stageKey]).toEqual(config.stages[stageKey]);
    }
  });

  it('is a no-op on re-run against an already-seeded install', async () => {
    await migration.up({ rootDir });
    const afterFirst = {
      config: readFileSync(installedConfigPath, 'utf-8'),
      bodies: specs.map(({ filename }) => readFileSync(join(stagesDir, filename), 'utf-8')),
    };

    await migration.up({ rootDir });

    expect(readFileSync(installedConfigPath, 'utf-8')).toBe(afterFirst.config);
    specs.forEach(({ filename }, i) => {
      expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(afterFirst.bodies[i]);
    });
  });

  it('never clobbers a customized template or an existing stage-config entry', async () => {
    // Pre-existing customized install: every template hand-edited, and the
    // first stage's config entry hand-tuned.
    const customBody = '# CUSTOMIZED — do not overwrite\n';
    for (const { filename } of specs) writeFileSync(join(stagesDir, filename), customBody);
    const tuned = { name: 'user-tuned', model: 'custom' };
    writeFileSync(
      installedConfigPath,
      `${JSON.stringify({ stages: { [specs[0].stageKey]: tuned } }, null, 2)}\n`,
    );

    await migration.up({ rootDir });

    for (const { filename } of specs) {
      expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(customBody);
    }
    const config = shippedConfig();
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf-8'));
    // Tuned entry preserved verbatim; the remaining entries still get added.
    expect(installed.stages[specs[0].stageKey]).toEqual(tuned);
    // Empty for a single-stage migration — the tuned-entry assertion above is the
    // whole point there. Most of the ~56 makeSeedMigration(s) migrations this
    // helper could cover are single-stage, so don't read this loop as coverage.
    for (const { stageKey } of specs.slice(1)) {
      expect(config.stages[stageKey], `data.reference stage-config missing entry: ${stageKey}`).toBeTruthy();
      expect(installed.stages[stageKey]).toEqual(config.stages[stageKey]);
    }
  });

  it('ships every referenced template and stage-config entry in data.reference (drift catch)', () => {
    // Guards the migration against a future rename/removal of a reference
    // asset, which would otherwise only surface at runtime as "Stage not found"
    // on a fresh install.
    const config = shippedConfig();
    for (const { stageKey, filename } of specs) {
      expect(existsSync(refStagePath(filename)), `data.reference template missing: ${filename}`).toBe(true);
      expect(config.stages[stageKey], `data.reference stage-config missing entry: ${stageKey}`).toBeTruthy();
    }
  });
}
