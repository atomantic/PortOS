/**
 * Tests for the legacy data/universes/{id}/index.json → Postgres importer (#1014).
 *
 * The legacy dir walk (readdir/stat), per-record JSON reads (readJSONFile),
 * marker I/O (readFile/writeFile), and the dir rename are mocked to in-memory
 * state; `db.query` is a fake honoring ON CONFLICT DO NOTHING. No disk, no PG.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory marker/legacy state.
let files = {};            // path → string (markers)
let dirEntries = null;     // readdir(legacyDir) result, or null = ENOENT
let recordsByDir = {};     // `${legacyDir}/${id}/index.json` → record object
let typeIndex = null;      // legacyDir/index.json content
let renameShouldFail = false;
let renamed = [];

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
  readJSONFile: vi.fn(async (path) => {
    if (path === '/fake/data/universes/index.json') return typeIndex;
    return recordsByDir[path] ?? null;
  }),
}));

// Marker I/O is delegated to migrationMarker.js; mock it against the same
// in-memory `files` map so the walk's gate/stamp behavior is exercised without
// the marker helper's real fs (the helper has its own unit test).
vi.mock('../lib/migrationMarker.js', () => ({
  markerExists: vi.fn(async (name) => (`/fake/data/${name}` in files)),
  writeMarker: vi.fn(async (name, payload) => { files[`/fake/data/${name}`] = JSON.stringify(payload, null, 2); }),
}));

vi.mock('fs/promises', () => ({
  rename: vi.fn(async (from, to) => {
    if (renameShouldFail) throw new Error('EACCES');
    renamed.push([from, to]);
  }),
  readdir: vi.fn(async () => {
    if (dirEntries === null) return [];
    return dirEntries;
  }),
  stat: vi.fn(async (path) => {
    if (path === '/fake/data/universes') {
      if (dirEntries === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => true };
    }
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }),
}));

let uTable;
let rTable;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO universes/.test(sql)) {
    const id = params[0];
    if (uTable.has(id)) return { rowCount: 0, rows: [] };
    uTable.set(id, { id, name: params[1], data: JSON.parse(params[2]) });
    return { rowCount: 1, rows: [] };
  }
  if (/INSERT INTO universe_runs/.test(sql)) {
    const id = params[0];
    if (rTable.has(id)) return { rowCount: 0, rows: [] };
    rTable.set(id, { id, universeId: params[1] });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const MARKER = '/fake/data/universes.migrated.json';
const rec = (id, extra = {}) => ({ id, name: id, schemaVersion: 4, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra });

async function importer() {
  const { migrateUniversesToDB } = await import('./migrateUniversesToDB.js');
  return migrateUniversesToDB();
}

beforeEach(() => {
  files = {};
  dirEntries = null;
  recordsByDir = {};
  typeIndex = null;
  renameShouldFail = false;
  renamed = [];
  uTable = new Map();
  rTable = new Map();
  query.mockClear();
});

describe('migrateUniversesToDB', () => {
  it('fresh install (no legacy dir): no-op WITHOUT a marker (keeps the recovery re-import hatch open)', async () => {
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    // No marker stamped — a later restore of data/universes.imported → data/universes
    // must re-import on the next boot rather than being silently suppressed.
    expect(MARKER in files).toBe(false);
    expect(uTable.size).toBe(0);
  });

  it('marker already present: no-op (does not re-walk)', async () => {
    files[MARKER] = JSON.stringify({ reason: 'imported' });
    dirEntries = ['u-1'];
    recordsByDir['/fake/data/universes/u-1/index.json'] = rec('u-1');
    const result = await importer();
    expect(result).toMatchObject({ reason: 'already-applied' });
    expect(uTable.size).toBe(0); // never touched the table
  });

  it('imports records + runs verbatim, then renames the dir aside and stamps marker', async () => {
    dirEntries = ['u-1', 'u-2', 'index.json', '.DS_Store'];
    recordsByDir['/fake/data/universes/u-1/index.json'] = rec('u-1', { logline: 'a' });
    recordsByDir['/fake/data/universes/u-2/index.json'] = rec('u-2');
    typeIndex = { config: { runs: [
      { id: 'r-1', universeId: 'u-1', jobIds: [], promptCount: 3, createdAt: '2026-01-03T00:00:00.000Z' },
    ] } };
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2, runs: 1 });
    expect(uTable.get('u-1').data.logline).toBe('a'); // verbatim
    expect(rTable.has('r-1')).toBe(true);
    expect(renamed).toEqual([['/fake/data/universes', '/fake/data/universes.imported']]);
    expect(MARKER in files).toBe(true);
  });

  it('is idempotent: a re-run over the same rows imports 0 (ON CONFLICT DO NOTHING)', async () => {
    dirEntries = ['u-1'];
    recordsByDir['/fake/data/universes/u-1/index.json'] = rec('u-1');
    uTable.set('u-1', { id: 'u-1' }); // already in the table from a prior partial run
    const result = await importer();
    expect(result.imported).toBe(0);
    expect(renamed.length).toBe(1); // still renames aside + stamps marker
    expect(MARKER in files).toBe(true);
  });

  it('skips a record whose index.json is missing/unparseable', async () => {
    dirEntries = ['u-1', 'u-bad'];
    recordsByDir['/fake/data/universes/u-1/index.json'] = rec('u-1');
    recordsByDir['/fake/data/universes/u-bad/index.json'] = null; // readJSONFile → null
    const result = await importer();
    expect(result.imported).toBe(1);
    expect(uTable.has('u-1')).toBe(true);
    expect(uTable.has('u-bad')).toBe(false);
  });

  it('rename failure leaves the marker UNwritten so next boot retries', async () => {
    dirEntries = ['u-1'];
    recordsByDir['/fake/data/universes/u-1/index.json'] = rec('u-1');
    renameShouldFail = true;
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported-rename-failed', imported: 1 });
    expect(MARKER in files).toBe(false); // no marker → retry next boot
    expect(uTable.has('u-1')).toBe(true); // rows already landed; retry is safe (ON CONFLICT)
  });
});
