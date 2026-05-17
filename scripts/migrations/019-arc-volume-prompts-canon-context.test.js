/**
 * Test for migration 019 — arc/volume prompt templates gain {{worldCanonText}}
 * (gated by {{#hasLinkedWorld}}).
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/migrations/**\/*.test.js`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import migration, { applyMigration } from './019-arc-volume-prompts-canon-context.js';

const md5 = (str) => createHash('md5')
  .update(str.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  .digest('hex');

// Mirror of the migration's hash table — when these change the test fixtures
// below need to mirror the change too.
const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': [
    'd34d72b8e49ba303d38607845dd87f1c',
    '6a3ecab43d1f46b7ef9aab6c69ea0326',
  ],
  'pipeline-arc-verify.md': [
    'ff56d8387162017e08d5d0491060ddd6',
    '52e31abc93e3105176236fcaa5d1575a',
  ],
  'pipeline-arc-resolve.md': [
    'a8677bbe1eb38f871fb152a5b0fec7c6',
    '87bc5c01f1a8a97b681727a38b05edc6',
  ],
  'pipeline-volume-verify.md': [
    '03f3c874cb80e1c98abcf03168fa7a92',
    'c6ea28e972ad6e229bafb2d602b4dda3',
  ],
};
const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md':   '0a1f6ffa6908522e3690c5e9e53a6ee0',
  'pipeline-arc-verify.md':     '36aa70cdfc25d7549573a4d556e7702c',
  'pipeline-arc-resolve.md':    '8e348f3d1894382889f9f0ee7d5c6792',
  'pipeline-volume-verify.md':  '49458d36700cb94e34806d536ffe2940',
};

// Lookup the real data.sample file for a given prompt; used to seed
// fixtures and to compute "current" file bodies for round-trip checks.
// Use fileURLToPath rather than `new URL(...).pathname` so a checkout under
// a path with spaces (or other URL-escapable chars) decodes correctly.
const repoRoot = join(import.meta.dirname || dirname(fileURLToPath(import.meta.url)), '..', '..');
const sampleBody = (filename) =>
  readFileSync(join(repoRoot, 'data.sample', 'prompts', 'stages', filename), 'utf-8');

// A synthetic body that hashes to none of the accepted-old hashes — used to
// stand in for a user-customized prompt template.
const customizedBody = (filename) => `# CUSTOMIZED ${filename}\n\nuser-modified content not matching any shipped hash\n`;

describe('migration 019 — arc/volume prompt canon context', () => {
  let rootDir;
  let stagesDir;
  let sampleDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-019-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    // Seed the sample dir with the actual updated content from the repo so
    // the migration has something to copy when it finds an old-hash match.
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(sampleDir, filename), sampleBody(filename));
    }
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops when the stage prompt is missing (setup-data.js will create it)', async () => {
    // No file in stagesDir; migration should skip without error.
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      expect(existsSync(join(stagesDir, filename))).toBe(false);
    }
  });

  it('skips files already at the new hash (idempotent re-run)', async () => {
    // Seed data/ with the same content as the sample (already migrated).
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(stagesDir, filename), sampleBody(filename));
    }
    const before = Object.fromEntries(
      Object.keys(NEW_SHIPPED_MD5).map((f) => [f, readFileSync(join(stagesDir, f), 'utf-8')]),
    );
    await migration.up({ rootDir });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      const after = readFileSync(join(stagesDir, filename), 'utf-8');
      expect(after).toBe(before[filename]); // unchanged
    }
  });

  it('NEW_SHIPPED_MD5 matches the live data.sample bodies (drift catch)', () => {
    // Without this assertion, a future template edit that forgets to bump
    // NEW_SHIPPED_MD5 would make the migration classify the sample-shaped
    // file as "customized" and silently skip the upgrade — the idempotency
    // test below would still pass (it checks "stays unchanged"), masking
    // the regression. This assertion fails loudly at release time.
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      const liveHash = md5(sampleBody(filename));
      expect(liveHash).toBe(NEW_SHIPPED_MD5[filename]);
    }
  });

  it('upgrades when on-disk hash matches an accepted-old entry (synthetic fixture)', async () => {
    // Plants a fixture body, registers its MD5 as the migration's "accepted
    // old" hash via the pure applyMigration helper, then asserts the file
    // gets rewritten to the data.sample version. Exercises the OLD→NEW
    // upgrade branch without depending on git history (shallow clones +
    // archive downloads work).
    const filename = 'pipeline-arc-resolve.md';
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
    // Belt-and-suspenders: catch a future hash-table edit that forgets a file.
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
});
