/**
 * Shared test scaffolding for the migration families in `./_lib.js`. The runner
 * skips `_`-prefixed files, so nothing here is ever executed as a migration.
 *
 *   - `runPromptMigrationTests` — hash-driven prompt-replace migrations. A
 *     per-migration `*.test.js` collapses to a `describe` + a single
 *     `runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5,
 *     NEW_SHIPPED_MD5, prefix })` call; six standard cases fire inside it.
 *   - `runSeededProviderTierMigrationTests` — seeded-provider-tier bumps built
 *     with `makeSeededProviderTierMigration`. Every fixture is derived from the
 *     migration's own `targets` table, so a bump's test is a `describe` + one
 *     call and still asserts the full conservative contract.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { md5, seededProviderTierModels } from './_lib.js';

export { md5 };

// scripts/migrations/_testHelpers.js → ../.. is the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');

export const sampleBody = (filename, subdir = 'stages') =>
  readFileSync(join(repoRoot, 'data.reference', 'prompts', subdir, filename), 'utf-8');

/** Synthetic body that won't match any shipped hash. */
export const customizedBody = (filename) =>
  `# CUSTOMIZED ${filename}\n\nuser-modified content not matching any shipped hash\n`;

/**
 * `prefix` is the `mkdtempSync` directory name — keep migration-specific
 * (`'migration-025-'`) so a debugger leaves a recognizable sandbox in `/tmp`.
 * `subdir` defaults to `'stages'`; pass `'_partials'` for shared mustache
 * fragments that live under `data/prompts/_partials/` instead.
 *
 * `createIfMissing` mirrors the migration's own `createIfMissing` flag (e.g.
 * migration 005). When true, the "missing on disk" case writes sample → data
 * instead of being a no-op, so the test asserts the sample body landed.
 */
export function runPromptMigrationTests({
  migration,
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  prefix,
  subdir = 'stages',
  createIfMissing = false,
}) {
  let rootDir;
  let stagesDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), prefix));
    stagesDir = join(rootDir, 'data', 'prompts', subdir);
    const sampleDir = join(rootDir, 'data.reference', 'prompts', subdir);
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(sampleDir, filename), sampleBody(filename, subdir));
    }
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it(
    createIfMissing
      ? 'creates from sample when the stage prompt is missing (createIfMissing)'
      : 'no-ops when the stage prompt is missing (setup-data.js will create it)',
    async () => {
      await expect(migration.up({ rootDir })).resolves.not.toThrow();
      for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
        const dataPath = join(stagesDir, filename);
        if (createIfMissing) {
          expect(existsSync(dataPath)).toBe(true);
          expect(readFileSync(dataPath, 'utf-8')).toBe(sampleBody(filename, subdir));
        } else {
          expect(existsSync(dataPath)).toBe(false);
        }
      }
    },
  );

  it('skips files already at the new hash (idempotent re-run)', async () => {
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(stagesDir, filename), sampleBody(filename, subdir));
    }
    const result = await applyMigration({ rootDir });
    expect(result).toMatchObject({
      updated: 0,
      alreadyCurrent: Object.keys(NEW_SHIPPED_MD5).length,
      skipped: 0,
    });
  });

  it('NEW_SHIPPED_MD5 matches the live data.reference body (drift catch)', () => {
    // Without this assertion, a future template edit that forgets to bump
    // NEW_SHIPPED_MD5 would make the migration classify the sample-shaped
    // file as "customized" and silently skip the upgrade.
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      expect(md5(sampleBody(filename, subdir))).toBe(NEW_SHIPPED_MD5[filename]);
    }
  });

  it('upgrades when on-disk hash matches an accepted-old entry (synthetic fixture)', async () => {
    const [filename] = Object.keys(NEW_SHIPPED_MD5);
    const fakeOldBody = `# synthetic pre-migration body for ${filename}\n`;
    const fakeOldHash = md5(fakeOldBody);

    writeFileSync(join(stagesDir, filename), fakeOldBody);
    const result = await applyMigration({
      rootDir,
      accepted: { [filename]: [fakeOldHash] },
      current: { [filename]: md5(sampleBody(filename, subdir)) },
    });
    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(sampleBody(filename, subdir));
  });

  it('skips (does not clobber) a customized file whose hash matches neither old nor new', async () => {
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(stagesDir, filename), customizedBody(filename));
    }
    await migration.up({ rootDir });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(customizedBody(filename));
    }
  });

  it('exposes ACCEPTED_OLD_MD5 and NEW_SHIPPED_MD5 with consistent shapes', () => {
    expect(Object.keys(ACCEPTED_OLD_MD5).sort()).toEqual(Object.keys(NEW_SHIPPED_MD5).sort());
    for (const old of Object.values(ACCEPTED_OLD_MD5)) {
      expect(Array.isArray(old)).toBe(true);
      expect(old.length).toBeGreaterThan(0);
      for (const h of old) expect(h).toMatch(/^[0-9a-f]{32}$/);
    }
    for (const h of Object.values(NEW_SHIPPED_MD5)) {
      expect(h).toMatch(/^[0-9a-f]{32}$/);
    }
  });
}

// ---- seeded-provider-tier bump migrations ----

/**
 * Expand a migration's `targets` table into everything the fixtures need: which
 * ids this bump retires, which survive it, and the post-bump `models` array.
 * Derived rather than hand-listed so a caller's data table is the only place a
 * model id is written down.
 */
const tierFixtures = (targets) =>
  Object.entries(targets).map(([id, target]) => ({
    id,
    target,
    retired: target.oldModels.filter((m) => Object.hasOwn(target.idMap, m)),
    surviving: target.oldModels.filter((m) => !Object.hasOwn(target.idMap, m)),
    newModels: seededProviderTierModels(target),
  }));

// A provider entry in its prior seeded shape: the old models list, with
// default/heavy parked on the last retired id (the Bedrock `[1m]` variant, when
// there is one) and light/medium on ids this bump does not touch.
const seededTierEntry = (f, overrides = {}) => ({
  id: f.id,
  models: [...f.target.oldModels],
  defaultModel: f.retired.at(-1),
  lightModel: f.surviving[0] ?? f.retired[0],
  mediumModel: f.surviving.at(-1) ?? f.retired[0],
  heavyModel: f.retired.at(-1),
  ...overrides,
});

// The same entry after a correct bump.
const bumpedTierEntry = (f, overrides = {}) => ({
  ...seededTierEntry(f),
  models: [...f.newModels],
  defaultModel: f.target.idMap[f.retired.at(-1)],
  heavyModel: f.target.idMap[f.retired.at(-1)],
  ...overrides,
});

/**
 * Standard suite for a migration built with `makeSeededProviderTierMigration`.
 * A bump's `*.test.js` collapses to a `describe` + a single
 * `runSeededProviderTierMigrationTests({ migration, targets, prefix })` call.
 *
 *   - `migration` — the migration's default export (`{ up }`).
 *   - `targets`   — the SAME `targets` table passed to the factory. Every
 *     fixture is derived from it, so the suite covers each provider and each
 *     retired id the bump actually ships.
 *   - `prefix`    — `mkdtempSync` directory name (`'migration-207-'`), so a
 *     debugger leaves a recognizable sandbox in the temp dir.
 *
 * The cases assert the family's conservative contract: exact-match-only
 * rewrites, like-for-like id mapping (a `[1m]` long-context pin must not drop a
 * context tier), still-current pointers preserved, orphan pointers repaired,
 * and a byte-for-byte no-op on anything customized or already current.
 */
export function runSeededProviderTierMigrationTests({ migration, targets, prefix }) {
  const fixtures = tierFixtures(targets);
  const ids = fixtures.map((f) => f.id);

  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data', 'providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const write = (providers) => writeFileSync(providersPath, JSON.stringify({ providers }, null, 2) + '\n');
  const read = () => JSON.parse(readFileSync(providersPath, 'utf-8')).providers;
  const raw = () => readFileSync(providersPath, 'utf-8');
  const entriesFrom = (build) => Object.fromEntries(fixtures.map((f) => [f.id, build(f)]));

  it('declares at least one retired id per target (the table actually bumps something)', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.retired.length).toBeGreaterThan(0);
      expect(f.newModels).not.toEqual(f.target.oldModels);
      // Every replacement must land in the post-bump list, or a pointer swap
      // would leave the provider pinned to a model it does not offer.
      for (const replacement of Object.values(f.target.idMap)) {
        expect(f.newModels).toContain(replacement);
      }
    }
  });

  it('rewrites the seeded models list and swaps the retired tier pointers', async () => {
    write(entriesFrom(seededTierEntry));

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'bumped', customized: [] });
    expect(result.touched.sort()).toEqual([...ids].sort());
    const out = read();
    for (const f of fixtures) {
      expect(out[f.id]).toEqual(bumpedTierEntry(f));
      expect(out[f.id].models).toContain(out[f.id].defaultModel);
    }
  });

  it('maps every retired id like-for-like (a [1m] long-context pin keeps its context tier)', async () => {
    for (const f of fixtures) {
      for (const retiredId of f.retired) {
        write({ [f.id]: seededTierEntry(f, { defaultModel: retiredId, heavyModel: retiredId }) });

        await migration.up({ rootDir });

        const after = read()[f.id];
        expect(after.defaultModel).toBe(f.target.idMap[retiredId]);
        expect(after.heavyModel).toBe(f.target.idMap[retiredId]);
        expect(after.models).toContain(after.defaultModel);
      }
    }
  });

  it('preserves a tier pointer parked on a still-current model', async () => {
    const withSurvivors = fixtures.filter((f) => f.surviving.length > 0);
    expect(withSurvivors.length).toBeGreaterThan(0);

    for (const f of withSurvivors) {
      const pinned = f.surviving[0];
      write({ [f.id]: seededTierEntry(f, { defaultModel: pinned }) });

      await migration.up({ rootDir });

      const after = read()[f.id];
      expect(after.defaultModel).toBe(pinned);
      expect(after.models).toEqual(f.newModels);
      expect(after.heavyModel).toBe(f.target.idMap[f.retired.at(-1)]);
    }
  });

  it('repairs an orphan retired pointer when the models list is already current', async () => {
    // A fresh seed from the new data.reference can still carry a pointer at a
    // now-absent id — left alone it would request a model the install no longer
    // lists.
    write(entriesFrom((f) => bumpedTierEntry(f, { defaultModel: f.retired.at(-1) })));

    const result = await migration.up({ rootDir });

    expect(result.touched.sort()).toEqual([...ids].sort());
    const out = read();
    for (const f of fixtures) {
      expect(out[f.id].defaultModel).toBe(f.target.idMap[f.retired.at(-1)]);
      expect(out[f.id].models).toContain(out[f.id].defaultModel);
    }
  });

  it('is a byte-for-byte no-op once models and pointers are current', async () => {
    write(entriesFrom(bumpedTierEntry));
    const before = raw();

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'no-change', touched: [] });
    expect(result.alreadyCurrent.sort()).toEqual([...ids].sort());
    expect(raw()).toBe(before);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    write(entriesFrom(seededTierEntry));
    await migration.up({ rootDir });
    const afterFirst = raw();

    await migration.up({ rootDir });

    expect(raw()).toBe(afterFirst);
  });

  it('skips a curated models list instead of resetting it to the shipped default', async () => {
    write(entriesFrom((f) => seededTierEntry(f, { models: f.target.oldModels.slice(1) })));
    const before = raw();

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'no-change' });
    expect(result.customized.sort()).toEqual([...ids].sort());
    expect(raw()).toBe(before);
  });

  it('treats a reordered seeded list as customization', async () => {
    const reorderable = fixtures.filter((f) => f.target.oldModels.length > 1);
    expect(reorderable.length).toBeGreaterThan(0);

    write(Object.fromEntries(reorderable.map((f) => [
      f.id,
      seededTierEntry(f, { models: [f.target.oldModels.at(-1), ...f.target.oldModels.slice(0, -1)] }),
    ])));
    const before = raw();

    await migration.up({ rootDir });

    expect(raw()).toBe(before);
  });

  it('leaves providers outside the target set untouched', async () => {
    const unrelated = { id: 'unrelated-provider', models: ['some-configured-default'], defaultModel: 'some-configured-default' };
    write({ ...entriesFrom(seededTierEntry), 'unrelated-provider': unrelated });

    await migration.up({ rootDir });

    expect(read()['unrelated-provider']).toEqual(unrelated);
  });

  it('is a no-op when data/providers.json is absent (fresh install seeds from data.reference)', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file' });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('leaves an unparseable file byte-identical rather than clobbering user data', async () => {
    writeFileSync(providersPath, '{ not valid json');

    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(raw()).toBe('{ not valid json');
  });

  it('leaves the file untouched when the providers map is missing or not an object', async () => {
    for (const doc of [{}, { providers: null }, { providers: 'nope' }]) {
      writeFileSync(providersPath, JSON.stringify(doc, null, 2) + '\n');
      const before = raw();

      expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'bad-shape' });
      expect(raw()).toBe(before);
    }
  });
}
