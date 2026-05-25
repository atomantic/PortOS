import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './034-split-universe-builder-to-per-uuid.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const validUniverse = (id, overrides = {}) => ({
  id,
  name: `Universe ${id}`,
  starterPrompt: 'test',
  categories: {},
  schemaVersion: 4,
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
  ...overrides,
});

describe('migration 034 — split universe-builder.json to per-UUID files', () => {
  let rootDir;
  let dataDir;
  let legacyPath;
  let typeDir;
  let typeIndexPath;
  let backupPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-034-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    legacyPath = join(dataDir, 'universe-builder.json');
    typeDir = join(dataDir, 'universes');
    typeIndexPath = join(typeDir, 'index.json');
    backupPath = legacyPath + '.bak-034';
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('fresh install: no legacy file → stamps an empty type index', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'fresh-install' });
    expect(existsSync(typeIndexPath)).toBe(true);
    const idx = readJson(typeIndexPath);
    expect(idx.schemaVersion).toBe(5);
    expect(idx.type).toBe('universes');
    expect(idx.config.runs).toEqual([]);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('full split: writes one file per universe and a type index', async () => {
    writeJson(legacyPath, {
      universes: [
        validUniverse('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', { name: 'Alpha' }),
        validUniverse('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', { name: 'Beta' }),
        validUniverse('cccccccc-3333-3333-3333-cccccccccccc', { name: 'Gamma' }),
      ],
      runs: [
        { id: 'run-1', universeId: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', collectionId: null, jobIds: [], promptCount: 0, createdAt: '2026-05-23T00:00:00.000Z' },
      ],
    });

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 3, skipped: 0, invalid: 0 });

    expect(existsSync(typeIndexPath)).toBe(true);
    const idx = readJson(typeIndexPath);
    expect(idx.schemaVersion).toBe(5);
    expect(idx.config.runs).toHaveLength(1);
    expect(idx.config.runs[0].id).toBe('run-1');

    for (const id of [
      'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
      'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
      'cccccccc-3333-3333-3333-cccccccccccc',
    ]) {
      const recordPath = join(typeDir, id, 'index.json');
      expect(existsSync(recordPath)).toBe(true);
      const rec = readJson(recordPath);
      expect(rec.id).toBe(id);
      expect(rec.schemaVersion).toBe(4); // record-shape version is preserved, NOT the type-level version
    }

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    const backup = readJson(backupPath);
    expect(backup.universes).toHaveLength(3);
  });

  it('idempotent: second run is a no-op once type index is at v5', async () => {
    writeJson(legacyPath, {
      universes: [validUniverse('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa')],
      runs: [],
    });
    await migration.up({ rootDir });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'already-applied' });
    // Backup still exists from the first run; not touched.
    expect(existsSync(backupPath)).toBe(true);
  });

  it('partial recovery: some records already split, finishes the rest', async () => {
    const ids = [
      'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
      'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
      'cccccccc-3333-3333-3333-cccccccccccc',
    ];
    writeJson(legacyPath, {
      universes: ids.map((id, i) => validUniverse(id, { name: `Universe-${i}-original` })),
      runs: [],
    });
    // Pre-split the FIRST record to simulate a crash mid-split. The pre-split
    // copy carries a name DIFFERENT from the legacy snapshot — the migration
    // must NOT clobber it (the per-record file is the freshest truth).
    mkdirSync(join(typeDir, ids[0]), { recursive: true });
    writeJson(join(typeDir, ids[0], 'index.json'), validUniverse(ids[0], { name: 'Universe-0-NEWER' }));

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 2, skipped: 1, invalid: 0 });

    const preserved = readJson(join(typeDir, ids[0], 'index.json'));
    expect(preserved.name).toBe('Universe-0-NEWER');

    for (const id of ids.slice(1)) {
      expect(existsSync(join(typeDir, id, 'index.json'))).toBe(true);
    }
    expect(existsSync(backupPath)).toBe(true);
  });

  it('skips records with invalid ids and counts them', async () => {
    writeJson(legacyPath, {
      universes: [
        validUniverse('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'),
        { id: 'x', name: 'too-short' },                            // id < 8 chars
        { id: '../escape-attempt-with-enough-length', name: 'evil' },// fails regex
        null,                                                       // not an object
      ],
      runs: [],
    });
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.invalid).toBe(3);
    expect(existsSync(join(typeDir, 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'index.json'))).toBe(true);
  });

  it('reports unreadable when the legacy file is corrupted', async () => {
    writeFileSync(legacyPath, 'not json');
    const result = await migration.up({ rootDir });
    // JSON.parse throws — the migration catches outside our code? Actually
    // readJson throws on parse error. Let's check the behavior matches.
    // (If parse throws, the migration propagates — test that explicitly.)
    expect(result.ok).toBe(false);
  });

  it('recovers from the .bak-034 file if the legacy was already renamed', async () => {
    // Simulate a crash AFTER rename but BEFORE the next boot ran migration —
    // the type index isn't written yet, so gate 1 doesn't trip; gate 2 sees
    // backup but no legacy, falls into the recovery branch.
    writeJson(backupPath, {
      universes: [validUniverse('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', { name: 'Recovered' })],
      runs: [],
    });
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    const rec = readJson(join(typeDir, 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'index.json'));
    expect(rec.name).toBe('Recovered');
    // Backup still in place — recovery path doesn't move it.
    expect(existsSync(backupPath)).toBe(true);
  });
});
