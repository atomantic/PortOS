import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './200-split-brain-stores-to-per-record.js';

const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

// A live brain record (no `id` field — the map KEY is the id).
const rec = (overrides = {}) => ({
  originInstanceId: 'inst-A',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

// An in-place tombstone (what brainStorage.remove writes).
const tombstone = (ts = '2026-07-02T00:00:00.000Z') => ({
  _deleted: true,
  updatedAt: ts,
  originInstanceId: 'inst-A',
  deletedAt: ts,
});

describe('migration 200 — split brain stores to per-record', () => {
  let rootDir;
  let dataDir;
  let brainDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-200-'));
    dataDir = join(rootDir, 'data');
    brainDir = join(dataDir, 'brain');
    mkdirSync(brainDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const typeDir = (type) => join(brainDir, type);
  const typeIndexPath = (type) => join(typeDir(type), 'index.json');
  const recordPath = (type, id) => join(typeDir(type), id, 'index.json');
  const legacyPath = (type) => join(brainDir, `${type}.json`);
  const backupPath = (type) => join(brainDir, `${type}.json.bak-200`);

  it('fresh install (no legacy files) stamps every type index at v1', async () => {
    const result = await migration.up({ rootDir });
    expect(result.ok).toBe(true);
    // All 10 brain entity types get an index.json stamped at v1.
    for (const type of ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets', 'journals', 'inbox', 'songs']) {
      expect(existsSync(typeIndexPath(type))).toBe(true);
      const idx = readJson(typeIndexPath(type));
      expect(idx.schemaVersion).toBe(1);
      expect(idx.type).toBe(type);
      expect(idx.config).toEqual({});
    }
  });

  it('splits a map-shaped store into per-record files and backs up the legacy file', async () => {
    writeJson(legacyPath('people'), {
      records: {
        'aaaaaaaa-1111': rec({ name: 'Alice' }),
        'bbbbbbbb-2222': rec({ name: 'Bob' }),
      },
    });

    await migration.up({ rootDir });

    // Records land at data/brain/people/<id>/index.json, id derived from the KEY.
    expect(readJson(recordPath('people', 'aaaaaaaa-1111')).name).toBe('Alice');
    expect(readJson(recordPath('people', 'bbbbbbbb-2222')).name).toBe('Bob');
    // The record value carries no `id` field (id is the directory name).
    expect(readJson(recordPath('people', 'aaaaaaaa-1111')).id).toBeUndefined();
    // Type index stamped.
    expect(readJson(typeIndexPath('people')).schemaVersion).toBe(1);
    // Legacy renamed, not deleted.
    expect(existsSync(legacyPath('people'))).toBe(false);
    expect(existsSync(backupPath('people'))).toBe(true);
    expect(Object.keys(readJson(backupPath('people')).records)).toHaveLength(2);
  });

  it('PRESERVES in-place tombstones through the split (LWW markers survive)', async () => {
    writeJson(legacyPath('links'), {
      records: {
        'live-0001': rec({ url: 'https://example.com' }),
        'dead-0002': tombstone('2026-07-05T00:00:00.000Z'),
      },
    });

    await migration.up({ rootDir });

    const live = readJson(recordPath('links', 'live-0001'));
    expect(live.url).toBe('https://example.com');
    const dead = readJson(recordPath('links', 'dead-0002'));
    expect(dead._deleted).toBe(true);
    expect(dead.updatedAt).toBe('2026-07-05T00:00:00.000Z');
    expect(dead.deletedAt).toBe('2026-07-05T00:00:00.000Z');
  });

  it('keys journals by calendar date and splits them like any other type', async () => {
    writeJson(legacyPath('journals'), {
      records: {
        '2026-07-18': rec({ note: 'wrote code' }),
        '2026-07-19': rec({ note: 'shipped it' }),
      },
    });

    await migration.up({ rootDir });

    expect(readJson(recordPath('journals', '2026-07-18')).note).toBe('wrote code');
    expect(readJson(recordPath('journals', '2026-07-19')).note).toBe('shipped it');
    expect(readJson(typeIndexPath('journals')).schemaVersion).toBe(1);
  });

  it('is idempotent — a second run is a no-op and leaves the backup untouched', async () => {
    writeJson(legacyPath('ideas'), { records: { 'idea-0001': rec({ title: 'X' }) } });

    await migration.up({ rootDir });
    const backupBefore = readFileSync(backupPath('ideas'), 'utf-8');

    const second = await migration.up({ rootDir });
    expect(second.ok).toBe(true);
    // Backup unchanged; record still present.
    expect(readFileSync(backupPath('ideas'), 'utf-8')).toBe(backupBefore);
    expect(readJson(recordPath('ideas', 'idea-0001')).title).toBe('X');
  });

  it('skips reserved map keys (__proto__ / constructor / prototype), leaving them in the backup', async () => {
    // Build the map WITHOUT __proto__ as a literal object key (that would set the
    // prototype), then attach reserved keys as own enumerable properties the way
    // JSON.parse would surface them.
    const records = { 'real-0001': rec({ name: 'ok' }) };
    Object.defineProperty(records, '__proto__', { value: rec({ name: 'evil' }), enumerable: true, configurable: true });
    records.constructor = rec({ name: 'ctor' });
    writeJson(legacyPath('admin'), { records });

    await migration.up({ rootDir });

    expect(existsSync(recordPath('admin', 'real-0001'))).toBe(true);
    expect(existsSync(recordPath('admin', '__proto__'))).toBe(false);
    expect(existsSync(recordPath('admin', 'constructor'))).toBe(false);
  });

  it('splits each type independently — one type with data does not affect the empty ones', async () => {
    writeJson(legacyPath('songs'), { records: { 'song-0001': rec({ title: 'Wonderwall' }) } });

    await migration.up({ rootDir });

    expect(readJson(recordPath('songs', 'song-0001')).title).toBe('Wonderwall');
    // A type with no legacy file still gets its index stamped (fresh-install path).
    expect(readJson(typeIndexPath('people')).schemaVersion).toBe(1);
    expect(existsSync(backupPath('people'))).toBe(false);
  });

  it('recovers from a .bak-200 backup when the split half-completed', async () => {
    // Simulate: legacy already renamed to backup, but records not yet split.
    writeJson(backupPath('projects'), { records: { 'proj-0001': rec({ name: 'PortOS' }) } });

    await migration.up({ rootDir });

    expect(readJson(recordPath('projects', 'proj-0001')).name).toBe('PortOS');
    expect(readJson(typeIndexPath('projects')).schemaVersion).toBe(1);
    // Backup left in place (recovery path never re-renames).
    expect(existsSync(backupPath('projects'))).toBe(true);
  });
});
