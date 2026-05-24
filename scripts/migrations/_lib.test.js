/**
 * Direct unit tests for `applyPromptReplaceMigration` opt-ins that aren't
 * exercised end-to-end by the per-migration `runPromptMigrationTests` helper:
 *
 *   - `createIfMissing` — copy sample → data when data is absent (mig 005)
 *   - `retireOnSampleMissing` — soft-delete data when sample is absent (mig 003)
 *
 * Per-migration tests still rely on the underlying loop logic; these
 * exercise the branches the helper guards behind opt-in flags.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { applyPromptReplaceMigration, md5, readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const FILENAME = 'pipeline-fake.md';
const BODY_OLD = '# OLD\n';
const BODY_NEW = '# NEW\n';
const BODY_CUSTOM = '# CUSTOMIZED\n';

const baseOpts = {
  accepted: { [FILENAME]: [md5(BODY_OLD)] },
  current: { [FILENAME]: md5(BODY_NEW) },
  label: 'fake',
  customizedHint: () => '',
};

describe('applyPromptReplaceMigration opt-ins', () => {
  let rootDir;
  let stagesDir;
  let sampleDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-lib-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    sampleDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe('createIfMissing', () => {
    it('copies the sample into data/ when data file is absent', async () => {
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, createIfMissing: true });
      expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_NEW);
    });

    it('no-ops when both data and sample are absent', async () => {
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, createIfMissing: true });
      expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('default `createIfMissing: false` leaves data absent', async () => {
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts });
      expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });
  });

  describe('retireOnSampleMissing', () => {
    it('soft-deletes an unmodified data file when the sample is gone', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 1, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('warns and skips when the data file was customized', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_CUSTOM);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 0, updated: 0, skipped: 1 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_CUSTOM);
    });

    it('retires even when data matches the current hash (sample renamed after the migration shipped)', async () => {
      // Regression: a user who already ran the migration (data at NEW hash)
      // and then pulled the rename should still get the now-obsolete file
      // cleaned up. Without this branch the file would be classified as
      // `alreadyCurrent` and left in `data/`.
      writeFileSync(join(stagesDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 1, alreadyCurrent: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('still applies the normal upgrade when the sample is present', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ updated: 1, retired: 0, skipped: 0 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_NEW);
    });

    it('default `retireOnSampleMissing: false` raises on missing sample for an old-hash file', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      await expect(
        applyPromptReplaceMigration({ rootDir, ...baseOpts }),
      ).rejects.toThrow(/ENOENT/);
    });
  });
});

describe('readLayoutsDoc / writeLayoutsDoc', () => {
  let rootDir;
  let dataDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-layouts-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    layoutsPath = join(dataDir, 'dashboard-layouts.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports no-state when the file is absent', async () => {
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-state');
    expect(result.path).toBe(layoutsPath);
  });

  it('reports unreadable for malformed JSON', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('reports no-layouts-array when the layouts key is missing or non-array', async () => {
    writeFileSync(layoutsPath, JSON.stringify({ activeLayoutId: 'default' }));
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
    writeFileSync(layoutsPath, JSON.stringify({ layouts: 'nope' }));
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
    writeFileSync(layoutsPath, 'null');
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
  });

  it('returns the parsed doc + path when valid', async () => {
    const doc = { activeLayoutId: 'default', layouts: [{ id: 'default', widgets: [] }] };
    writeFileSync(layoutsPath, JSON.stringify(doc));
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(layoutsPath);
    expect(result.doc).toEqual(doc);
  });

  it('round-trips through writeLayoutsDoc with 2-space indentation', async () => {
    const doc = { activeLayoutId: 'default', layouts: [{ id: 'default', widgets: ['cos'] }] };
    await writeLayoutsDoc(layoutsPath, doc);
    const raw = readFileSync(layoutsPath, 'utf-8');
    expect(raw).toBe(JSON.stringify(doc, null, 2));
    const reread = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(reread.ok).toBe(true);
    expect(reread.doc).toEqual(doc);
  });
});
