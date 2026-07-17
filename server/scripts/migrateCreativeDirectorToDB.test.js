/**
 * Tests for the legacy creative-director-projects.json → Postgres importer.
 *
 * Marker file I/O + the legacy file read/rename are mocked to an in-memory
 * blob; `db.query` is a fake that records INSERTs and honors ON CONFLICT DO
 * NOTHING. No disk, no Postgres.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory filesystem keyed by absolute path.
let files = {};

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
}));

// Rename can be made to fail per-test via `renameShouldFail`.
let renameShouldFail = false;

// Marker I/O is delegated to migrationMarker.js; mock it against the same
// in-memory `files` map (the marker helper has its own unit test).
vi.mock('../lib/migrationMarker.js', () => ({
  markerExists: vi.fn(async (name) => (`/fake/data/${name}` in files)),
  writeMarker: vi.fn(async (name, payload) => { files[`/fake/data/${name}`] = JSON.stringify(payload, null, 2); }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path) => {
    if (!(path in files)) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return files[path];
  }),
  rename: vi.fn(async (from, to) => {
    if (renameShouldFail) throw new Error('EACCES: rename failed');
    files[to] = files[from];
    delete files[from];
  }),
}));

// Fake DB: a Map standing in for creative_director_projects, with ON CONFLICT
// DO NOTHING semantics.
let table;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO creative_director_projects/.test(sql)) {
    const [id, status, data] = params;
    if (table.has(id)) return { rowCount: 0, rows: [] };
    table.set(id, { id, status, data: JSON.parse(data) });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const LEGACY = '/fake/data/creative-director-projects.json';
const MARKER = '/fake/data/creative-director-projects.migrated.json';
const IMPORTED = LEGACY + '.imported';

const { migrateCreativeDirectorToDB } = await import('./migrateCreativeDirectorToDB.js');

beforeEach(() => {
  files = {};
  table = new Map();
  renameShouldFail = false;
  query.mockClear();
});

describe('migrateCreativeDirectorToDB', () => {
  it('fresh install (no legacy file): stamps marker, imports nothing', async () => {
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    expect(files[MARKER]).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it('imports legacy projects into the table and renames the file aside', async () => {
    files[LEGACY] = JSON.stringify([
      { id: 'cd-1', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'cd-2', status: 'draft', createdAt: '2026-01-03T00:00:00.000Z' },
    ]);
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(table.has('cd-1')).toBe(true);
    expect(table.has('cd-2')).toBe(true);
    // Legacy renamed aside (recovery source), marker written.
    expect(files[LEGACY]).toBeUndefined();
    expect(files[IMPORTED]).toBeTruthy();
    expect(files[MARKER]).toBeTruthy();
  });

  it('is a no-op on the second run (marker present)', async () => {
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }]);
    await migrateCreativeDirectorToDB();
    query.mockClear();
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: true, reason: 'already-applied' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not clobber a row already in the table (ON CONFLICT DO NOTHING)', async () => {
    table.set('cd-1', { id: 'cd-1', status: 'rendering', data: { fresher: true } });
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(table.get('cd-1').data).toEqual({ fresher: true });
  });

  it('imports run history LOSSLESSLY — does not trim a >200-run project', async () => {
    // Regression: the importer must NOT apply the live-store runs[] cap, or
    // existing installs with long CD histories silently lose run rows on migrate.
    const runs = Array.from({ length: 350 }, (_, i) => ({ runId: `r${i}`, status: 'completed' }));
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'complete', runs }]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(1);
    expect(table.get('cd-1').data.runs).toHaveLength(350);
  });

  it('sanitizes malformed status/timestamp mirror columns without dropping the row', async () => {
    // A legacy record with a junk timestamp or over-long status must still
    // import (data verbatim) — the typed mirror columns get safe fallbacks so
    // the INSERT can't throw and block backend init on upgrade.
    files[LEGACY] = JSON.stringify([
      { id: 'cd-1', status: 'x'.repeat(80), createdAt: 'not-a-date', updatedAt: 12345, data: 'keep' },
    ]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(1);
    const inserted = query.mock.calls.find((c) => /INSERT/.test(c[0]));
    const [, status, , createdAt, updatedAt] = inserted[1];
    expect(status.length).toBeLessThanOrEqual(32);
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
    // The full record (including the bad fields) is preserved verbatim in data.
    expect(table.get('cd-1').data.createdAt).toBe('not-a-date');
  });

  it('does NOT stamp the marker when the legacy rename fails (retries next boot)', async () => {
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }]);
    renameShouldFail = true;
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: false, reason: 'rename-failed', imported: 1 });
    // Row landed, but legacy file still present and marker NOT written → retry.
    expect(table.has('cd-1')).toBe(true);
    expect(files[LEGACY]).toBeTruthy();
    expect(files[MARKER]).toBeUndefined();
  });

  it('skips malformed records (missing id) without aborting the import', async () => {
    files[LEGACY] = JSON.stringify([{ id: 'cd-1', status: 'draft' }, { noId: true }, null]);
    const result = await migrateCreativeDirectorToDB();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('leaves a corrupt legacy file in place for repair (no marker, no rename)', async () => {
    files[LEGACY] = '{ not valid json';
    const result = await migrateCreativeDirectorToDB();
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(files[LEGACY]).toBeTruthy();   // untouched
    expect(files[MARKER]).toBeUndefined(); // not stamped → retries next boot
  });
});
