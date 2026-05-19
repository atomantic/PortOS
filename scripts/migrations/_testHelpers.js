/**
 * Shared test scaffolding for hash-driven prompt-replace migrations.
 * Companion to `./_lib.js`. The runner skips `_`-prefixed files.
 *
 * Per-migration `*.test.js` collapses to a `describe` + a single
 * `runPromptMigrationTests({ migration, applyMigration, ACCEPTED_OLD_MD5,
 * NEW_SHIPPED_MD5, prefix })` call — six standard cases fire inside it.
 */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { md5 } from './_lib.js';

export { md5 };

// scripts/migrations/_testHelpers.js → ../.. is the repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');

export const sampleBody = (filename, subdir = 'stages') =>
  readFileSync(join(repoRoot, 'data.sample', 'prompts', subdir, filename), 'utf-8');

/** Synthetic body that won't match any shipped hash. */
export const customizedBody = (filename) =>
  `# CUSTOMIZED ${filename}\n\nuser-modified content not matching any shipped hash\n`;

/**
 * `prefix` is the `mkdtempSync` directory name — keep migration-specific
 * (`'migration-025-'`) so a debugger leaves a recognizable sandbox in `/tmp`.
 * `subdir` defaults to `'stages'`; pass `'_partials'` for shared mustache
 * fragments that live under `data/prompts/_partials/` instead.
 */
export function runPromptMigrationTests({
  migration,
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  prefix,
  subdir = 'stages',
}) {
  let rootDir;
  let stagesDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), prefix));
    stagesDir = join(rootDir, 'data', 'prompts', subdir);
    const sampleDir = join(rootDir, 'data.sample', 'prompts', subdir);
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(sampleDir, filename), sampleBody(filename, subdir));
    }
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops when the stage prompt is missing (setup-data.js will create it)', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      expect(existsSync(join(stagesDir, filename))).toBe(false);
    }
  });

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

  it('NEW_SHIPPED_MD5 matches the live data.sample body (drift catch)', () => {
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
