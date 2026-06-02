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

import { applyPromptReplaceMigration, md5, readLayoutsDoc, writeLayoutsDoc, makeSplitMigration } from './_lib.js';

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

// The four real split migrations (034/035/036/059) exercise the factory
// end-to-end in their own suites; these tests pin the DISTINGUISHING FLAGS in
// isolation so a future edit to makeSplitMigration that breaks one flag fails
// loudly here even if the per-migration suites still pass by coincidence.
describe('makeSplitMigration flags', () => {
  let rootDir;
  let dataDir;
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

  // Minimal config; individual tests spread overrides over this.
  const base = {
    migrationLabel: 'migration test',
    typeDirName: 'widgets',
    legacyFilename: 'widgets.json',
    backupSuffix: '.bak-test',
    typeSchemaVersion: 1,
    typeLabel: 'widgets',
    recordsKey: 'widgets',
    idPattern: /^w-[A-Za-z0-9]+$/,
    recordNoun: 'widget',
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'split-flags-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const seedLegacy = (records) =>
    writeFileSync(join(dataDir, 'widgets.json'), JSON.stringify({ widgets: records }) + '\n');

  it('buildConfig defaults to {} and receives the parsed doc', async () => {
    seedLegacy([{ id: 'w-1' }]);
    const mig = makeSplitMigration({ ...base, buildConfig: (doc) => ({ count: doc.widgets.length }) });
    await mig.up({ rootDir });
    expect(readJson(join(dataDir, 'widgets', 'index.json')).config).toEqual({ count: 1 });

    // Default buildConfig → {} on a fresh install (doc is null).
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    await makeSplitMigration(base).up({ rootDir });
    expect(readJson(join(dataDir, 'widgets', 'index.json')).config).toEqual({});
  });

  it('dedupe:false writes a duplicate id twice-attempted (second skipped only if already on disk), dedupe:true is first-wins', async () => {
    // Without dedupe, two records with the same id: the second overwrites via
    // the same dir (no in-loop claim), so written counts both attempts minus
    // the on-disk skip. Assert the first-wins SURVIVOR differs by flag.
    seedLegacy([{ id: 'w-1', tag: 'first' }, { id: 'w-1', tag: 'second' }]);
    const deduped = makeSplitMigration({ ...base, dedupe: true });
    const res = await deduped.up({ rootDir });
    expect(res).toMatchObject({ written: 1, skipped: 1, invalid: 0 });
    expect(readJson(join(dataDir, 'widgets', 'w-1', 'index.json')).tag).toBe('first');
  });

  it('extraValid rejects records failing the predicate (counted invalid)', async () => {
    seedLegacy([{ id: 'w-1', name: 'ok' }, { id: 'w-2', name: '' }]);
    const mig = makeSplitMigration({ ...base, extraValid: (r) => typeof r.name === 'string' && !!r.name.trim() });
    const res = await mig.up({ rootDir });
    expect(res).toMatchObject({ written: 1, invalid: 1 });
    expect(existsSync(join(dataDir, 'widgets', 'w-1', 'index.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'widgets', 'w-2', 'index.json'))).toBe(false);
  });

  it("onUnreadable:'return' reports {ok:false} and stamps nothing", async () => {
    writeFileSync(join(dataDir, 'widgets.json'), 'not json');
    const res = await makeSplitMigration({ ...base, onUnreadable: 'return' }).up({ rootDir });
    expect(res).toEqual({ ok: false, reason: 'unreadable' });
    expect(existsSync(join(dataDir, 'widgets', 'index.json'))).toBe(false);
  });

  it("onUnreadable:'throw' throws and stamps nothing (stays pending for a re-split)", async () => {
    writeFileSync(join(dataDir, 'widgets.json'), 'not json');
    const mig = makeSplitMigration({ ...base, onUnreadable: 'throw' });
    await expect(mig.up({ rootDir })).rejects.toThrow(/unreadable/);
    expect(existsSync(join(dataDir, 'widgets', 'index.json'))).toBe(false);
  });
});
