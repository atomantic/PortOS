/**
 * Test for migration 027 — text-stage prompts gain {{worldEntitiesSummary}}
 * and pipe {{speechAccent}} / {{speechPattern}} through character renders.
 *
 * Mirrors migration 019's test scaffolding — temp-dir fixtures, the same
 * drift-catch assertion against the live data.sample bodies, and an
 * OLD→NEW upgrade branch driven by synthetic hash tables so the test
 * doesn't depend on git history.
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

import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './027-text-stage-prompts-entities-summary.js';

const md5 = (str) => createHash('md5')
  .update(str.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  .digest('hex');

const repoRoot = join(import.meta.dirname || dirname(fileURLToPath(import.meta.url)), '..', '..');
const sampleBody = (filename) =>
  readFileSync(join(repoRoot, 'data.sample', 'prompts', 'stages', filename), 'utf-8');

const customizedBody = (filename) => `# CUSTOMIZED ${filename}\n\nuser-modified content not matching any shipped hash\n`;

describe('migration 027 — text-stage prompts entities-summary + speechPattern', () => {
  let rootDir;
  let stagesDir;
  let sampleDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-027-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    sampleDir = join(rootDir, 'data.sample', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      writeFileSync(join(sampleDir, filename), sampleBody(filename));
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
      writeFileSync(join(stagesDir, filename), sampleBody(filename));
    }
    const before = Object.fromEntries(
      Object.keys(NEW_SHIPPED_MD5).map((f) => [f, readFileSync(join(stagesDir, f), 'utf-8')]),
    );
    const result = await applyMigration({ rootDir });
    expect(result).toMatchObject({
      updated: 0,
      alreadyCurrent: Object.keys(NEW_SHIPPED_MD5).length,
      skipped: 0,
    });
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      const after = readFileSync(join(stagesDir, filename), 'utf-8');
      expect(after).toBe(before[filename]);
    }
  });

  it('NEW_SHIPPED_MD5 matches the live data.sample bodies (drift catch)', () => {
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      const liveHash = md5(sampleBody(filename));
      expect(liveHash).toBe(NEW_SHIPPED_MD5[filename]);
    }
  });

  it('upgrades when on-disk hash matches an accepted-old entry (synthetic fixture)', async () => {
    const filename = 'pipeline-prose.md';
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
});
