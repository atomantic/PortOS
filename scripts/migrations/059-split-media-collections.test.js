import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './059-split-media-collections.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const collection = (id, overrides = {}) => ({
  id,
  name: `Collection ${id}`,
  description: '',
  coverKey: null,
  universeId: null,
  seriesId: null,
  items: [],
  createdAt: '2026-05-31T00:00:00.000Z',
  updatedAt: '2026-05-31T00:00:00.000Z',
  deleted: false,
  deletedAt: null,
  ...overrides,
});

describe('migration 059 — split media-collections.json to per-record files', () => {
  let rootDir;
  let dataDir;
  let legacyPath;
  let typeDir;
  let typeIndexPath;
  let backupPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-059-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    legacyPath = join(dataDir, 'media-collections.json');
    typeDir = join(dataDir, 'media-collections');
    typeIndexPath = join(typeDir, 'index.json');
    backupPath = legacyPath + '.bak-059';
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('fresh install: no legacy file → stamps an empty type index', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'fresh-install' });
    expect(existsSync(typeIndexPath)).toBe(true);
    const idx = readJson(typeIndexPath);
    expect(idx.schemaVersion).toBe(1);
    expect(idx.type).toBe('mediaCollections');
    expect(idx.config).toEqual({});
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });

  it('full split: writes one file per collection and a type index', async () => {
    writeJson(legacyPath, {
      collections: [
        collection('11111111-1111-1111-1111-111111111111', { name: 'Standalone' }),
        collection('uc-aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', { name: 'Universe: Alpha', universeId: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa' }),
        collection('sc-bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', { name: 'Series: Beta', seriesId: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb' }),
      ],
    });

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 3, skipped: 0, invalid: 0 });

    expect(existsSync(typeIndexPath)).toBe(true);
    const idx = readJson(typeIndexPath);
    expect(idx.schemaVersion).toBe(1);
    expect(idx.config).toEqual({});

    for (const id of [
      '11111111-1111-1111-1111-111111111111',
      'uc-aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
      'sc-bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
    ]) {
      const recordPath = join(typeDir, id, 'index.json');
      expect(existsSync(recordPath)).toBe(true);
      expect(readJson(recordPath).id).toBe(id);
    }

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect(readJson(backupPath).collections).toHaveLength(3);
  });

  it('idempotent: second run is a no-op once type index is at v1', async () => {
    writeJson(legacyPath, {
      collections: [collection('11111111-1111-1111-1111-111111111111')],
    });
    await migration.up({ rootDir });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'already-applied' });
    expect(existsSync(backupPath)).toBe(true);
  });

  it('partial recovery: some records already split, finishes the rest', async () => {
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ];
    writeJson(legacyPath, {
      collections: ids.map((id, i) => collection(id, { name: `Collection-${i}-original` })),
    });
    // Pre-split the FIRST record with a name DIFFERENT from the legacy snapshot
    // — the migration must NOT clobber it (the per-record file is freshest).
    mkdirSync(join(typeDir, ids[0]), { recursive: true });
    writeJson(join(typeDir, ids[0], 'index.json'), collection(ids[0], { name: 'Collection-0-NEWER' }));

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'split', written: 2, skipped: 1, invalid: 0 });

    expect(readJson(join(typeDir, ids[0], 'index.json')).name).toBe('Collection-0-NEWER');
    for (const id of ids.slice(1)) {
      expect(existsSync(join(typeDir, id, 'index.json'))).toBe(true);
    }
    expect(existsSync(backupPath)).toBe(true);
  });

  it('skips records with invalid ids and counts them', async () => {
    writeJson(legacyPath, {
      collections: [
        collection('11111111-1111-1111-1111-111111111111'),
        { id: 'has spaces', name: 'invalid id' },        // space fails idPattern
        { id: '../escape', name: 'evil' },               // slash + dot fails idPattern
        null,                                            // not an object
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.invalid).toBe(3);
    expect(existsSync(join(typeDir, '11111111-1111-1111-1111-111111111111', 'index.json'))).toBe(true);
  });

  it('reports unreadable when the legacy file is corrupted', async () => {
    writeFileSync(legacyPath, 'not json');
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(false);
  });

  it('recovers from the .bak-059 file if the legacy was already renamed', async () => {
    // Crash AFTER rename but BEFORE the type index was written — gate 1 doesn't
    // trip; gate 2 sees backup but no legacy, falls into the recovery branch.
    writeJson(backupPath, {
      collections: [collection('11111111-1111-1111-1111-111111111111', { name: 'Recovered' })],
    });
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(readJson(join(typeDir, '11111111-1111-1111-1111-111111111111', 'index.json')).name).toBe('Recovered');
    expect(existsSync(backupPath)).toBe(true);
  });
});
