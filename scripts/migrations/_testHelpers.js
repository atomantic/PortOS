/**
 * Shared test scaffolding for the migration families in `./_lib.js`. The runner
 * skips `_`-prefixed files, so nothing here is ever executed as a migration.
 *
 *   - `runPromptMigrationTests` — hash-driven prompt-replace migrations. A
 *     per-migration `*.test.js` collapses to a `describe` + a single
 *     `runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5,
 *     NEW_SHIPPED_MD5, prefix })` call; five standard cases fire inside it.
 *   - `runAdditiveProviderInsertMigrationTests` — additive provider-model
 *     inserts built with `makeAdditiveProviderInsertMigration` (family 7).
 *     Same shape: a `describe` + one call, with fixtures derived from the
 *     migration's own `targets` array.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { md5 } from './_lib.js';
import { pathWithin } from '../lib/pathWithin.js';

export { md5 };

// scripts/migrations/_testHelpers.js → ../.. is the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');

// pathWithin: each migration test passes its own names, so the test memo keys the
// shipped prompts tree, and this read may not leave it.
export const sampleBody = (filename) =>
  readFileSync(pathWithin(join(repoRoot, 'data.reference', 'prompts'), 'stages', filename), 'utf-8');

/** Synthetic body that won't match any shipped hash. */
export const customizedBody = (filename) =>
  `# CUSTOMIZED ${filename}\n\nuser-modified content not matching any shipped hash\n`;

/**
 * `prefix` is the `mkdtempSync` directory name — keep migration-specific
 * (`'migration-005-'`) so a debugger leaves a recognizable sandbox in `/tmp`.
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
  createIfMissing = false,
}) {
  let rootDir;
  let stagesDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), prefix));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(sampleDir, filename), sampleBody(filename));
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
          expect(readFileSync(dataPath, 'utf-8')).toBe(sampleBody(filename));
        } else {
          expect(existsSync(dataPath)).toBe(false);
        }
      }
    },
  );

  // The live reference body is current even after a later template edit
  // leaves NEW_SHIPPED_MD5 behind (#16090), so this also covers drift.
  it('skips files already at the live reference body (idempotent re-run)', async () => {
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(stagesDir, filename), sampleBody(filename));
    }
    const result = await applyMigration({ rootDir });
    expect(result).toMatchObject({
      updated: 0,
      alreadyCurrent: Object.keys(NEW_SHIPPED_MD5).length,
      skipped: 0,
    });
  });

  it('upgrades when on-disk hash matches an accepted-old entry (synthetic fixture)', async () => {
    const [filename] = Object.keys(NEW_SHIPPED_MD5);
    const fakeOldBody = `# synthetic pre-migration body for ${filename}\n`;
    const fakeOldHash = md5(fakeOldBody);

    writeFileSync(join(stagesDir, filename), fakeOldBody);
    const result = await applyMigration({
      rootDir,
      accepted: { [filename]: [fakeOldHash] },
      current: { [filename]: md5(sampleBody(filename)) },
    });
    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(readFileSync(join(stagesDir, filename), 'utf-8')).toBe(sampleBody(filename));
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

// ---- additive provider-model insert migrations (family 7b) ----

/**
 * Standard suite for a migration built with `makeAdditiveProviderInsertMigration`.
 * A migration's `*.test.js` collapses to a `describe` + a single
 * `runAdditiveProviderInsertMigrationTests({ migration, targets, prefix })` call.
 *
 *   - `migration` — the migration's default export (`{ up }`).
 *   - `targets`   — the SAME `targets` array passed to the factory
 *     (`[{ id, retired, current }, …]`). Every fixture is derived from it, so
 *     the suite covers each target the migration actually ships.
 *   - `prefix`    — `mkdtempSync` directory name (`'migration-337-'`), so a
 *     debugger leaves a recognizable sandbox in the temp dir.
 */
export function runAdditiveProviderInsertMigrationTests({ migration, targets, prefix }) {
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

  it('declares at least one target', () => {
    expect(targets.length).toBeGreaterThan(0);
    for (const { retired, current } of targets) {
      expect(retired).not.toBe(current);
    }
  });

  it('inserts each target\'s current id right after its retired id on a curated list, leaving pointers alone', async () => {
    write(Object.fromEntries(targets.map(({ id, retired }) => [
      id,
      { models: ['unrelated-tier', retired, 'sibling-tier'], defaultModel: 'unrelated-tier', mediumModel: retired },
    ])));

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'updated', updated: targets.length });
    const out = read();
    for (const { id, retired, current } of targets) {
      expect(out[id].models).toEqual(['unrelated-tier', retired, current, 'sibling-tier']);
      // Additive: the retired id and every tier pointer survive untouched.
      expect(out[id].defaultModel).toBe('unrelated-tier');
      expect(out[id].mediumModel).toBe(retired);
    }
  });

  it('never offers one target\'s current id on a different target\'s record', async () => {
    const distinct = targets.filter(({ current }, i) => targets.findIndex((t) => t.current === current) === i);
    if (distinct.length < 2) return; // nothing to cross-check when every target shares one id
    write(Object.fromEntries(targets.map(({ id, retired }) => [id, { models: [retired] }])));

    await migration.up({ rootDir });

    const out = read();
    for (const { id, current } of targets) {
      for (const other of distinct) {
        if (other.current === current) continue;
        expect(out[id].models).not.toContain(other.current);
      }
    }
  });

  it('is a no-op on an already-current record and on a second run', async () => {
    const [first, ...rest] = targets;
    write(Object.fromEntries([
      [first.id, { models: [first.retired, first.current] }],
      ...rest.map(({ id, retired }) => [id, { models: [retired] }]),
    ]));

    const before = raw();
    const firstRun = await migration.up({ rootDir });
    expect(firstRun.updated).toBe(rest.length);
    if (rest.length > 0) expect(raw()).not.toBe(before); // the repairable targets did get written once

    // A record repaired on the first run is untouched by a second — no
    // duplicate insert — and the already-current record was never touched.
    const secondRun = await migration.up({ rootDir });
    expect(secondRun).toMatchObject({ ok: true, reason: 'already-current', updated: 0 });
    for (const { id, retired, current } of targets) {
      expect(read()[id].models).toEqual([retired, current]);
    }
  });

  it('leaves providers outside the target set untouched', async () => {
    const unrelated = { id: 'unrelated-provider', models: ['some-configured-default'], defaultModel: 'some-configured-default' };
    write({
      ...Object.fromEntries(targets.map(({ id, retired }) => [id, { models: [retired] }])),
      'unrelated-provider': unrelated,
    });

    await migration.up({ rootDir });

    expect(read()['unrelated-provider']).toEqual(unrelated);
  });

  it('skips a missing or malformed providers file without throwing', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file' });

    writeFileSync(providersPath, '{not json');
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'unreadable' });

    writeFileSync(providersPath, JSON.stringify({ activeProvider: 'x' }, null, 2) + '\n');
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'bad-shape' });
  });

  it('skips a record whose models field is not an array', async () => {
    const [first] = targets;
    write({ [first.id]: { models: first.retired, defaultModel: first.retired } });

    expect((await migration.up({ rootDir })).updated).toBe(0);
    expect(read()[first.id].models).toBe(first.retired);
  });
}
