/**
 * Tests for the legacy data/pipeline-series/{id}/index.json → Postgres importer
 * (#1015). Unlike the universe importer, this renames each record's index.json
 * aside IN PLACE (not the whole dir) so the file-primary manuscript-review.json
 * siblings stay readable at their canonical path. Disk + PG are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let files = {};            // path → string (markers)
let dirEntries = null;     // readdir(legacyDir) result, or null = ENOENT
let recordsByDir = {};     // `${legacyDir}/${id}/index.json` → record object
let renamed = [];

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
  readJSONFile: vi.fn(async (path) => recordsByDir[path] ?? null),
}));

// Marker I/O is delegated to migrationMarker.js; mock it against the same
// in-memory `files` map (the marker helper has its own unit test).
vi.mock('../lib/migrationMarker.js', () => ({
  markerExists: vi.fn(async (name) => (`/fake/data/${name}` in files)),
  writeMarker: vi.fn(async (name, payload) => { files[`/fake/data/${name}`] = JSON.stringify(payload, null, 2); }),
}));

vi.mock('fs/promises', () => ({
  rename: vi.fn(async (from, to) => { renamed.push([from, to]); }),
  readdir: vi.fn(async () => (dirEntries === null ? [] : dirEntries)),
  stat: vi.fn(async (path) => {
    if (path === '/fake/data/pipeline-series') {
      if (dirEntries === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => true };
    }
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }),
}));

let table;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO pipeline_series/.test(sql)) {
    const id = params[0];
    if (table.has(id)) return { rowCount: 0, rows: [] };
    table.set(id, { id, name: params[1], universeId: params[2], data: JSON.parse(params[4]) });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const MARKER = '/fake/data/pipeline-series.migrated.json';
const rec = (id, extra = {}) => ({ id, name: id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra });

async function importer() {
  const { migrateSeriesToDB } = await import('./migrateSeriesToDB.js');
  return migrateSeriesToDB();
}

beforeEach(() => {
  files = {};
  dirEntries = null;
  recordsByDir = {};
  renamed = [];
  table = new Map();
  query.mockClear();
});

describe('migrateSeriesToDB', () => {
  it('fresh install (no legacy dir): no-op WITHOUT a marker', async () => {
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    expect(MARKER in files).toBe(false);
    expect(table.size).toBe(0);
  });

  it('marker already present: no-op (does not re-walk)', async () => {
    files[MARKER] = JSON.stringify({ reason: 'imported' });
    dirEntries = ['ser-1'];
    recordsByDir['/fake/data/pipeline-series/ser-1/index.json'] = rec('ser-1');
    const result = await importer();
    expect(result).toMatchObject({ reason: 'already-applied' });
    expect(table.size).toBe(0);
  });

  it('imports records verbatim, renames each index.json aside IN PLACE, stamps marker', async () => {
    dirEntries = ['ser-1', 'ser-2', 'index.json', '.DS_Store'];
    recordsByDir['/fake/data/pipeline-series/ser-1/index.json'] = rec('ser-1', { universeId: 'u-1', logline: 'a' });
    recordsByDir['/fake/data/pipeline-series/ser-2/index.json'] = rec('ser-2');
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(table.get('ser-1').data.logline).toBe('a'); // verbatim
    expect(table.get('ser-1').universeId).toBe('u-1'); // mirror column
    // Per-record index.json renamed aside — dir itself NOT renamed (siblings stay).
    expect(renamed).toContainEqual(['/fake/data/pipeline-series/ser-1/index.json', '/fake/data/pipeline-series/ser-1/index.json.imported']);
    expect(renamed).toContainEqual(['/fake/data/pipeline-series/ser-2/index.json', '/fake/data/pipeline-series/ser-2/index.json.imported']);
    // The whole-dir rename the universe importer does must NOT happen here.
    expect(renamed.some(([from]) => from === '/fake/data/pipeline-series')).toBe(false);
    expect(MARKER in files).toBe(true);
  });

  it('is idempotent: a re-run over the same rows imports 0 (ON CONFLICT DO NOTHING)', async () => {
    dirEntries = ['ser-1'];
    recordsByDir['/fake/data/pipeline-series/ser-1/index.json'] = rec('ser-1');
    table.set('ser-1', { id: 'ser-1' });
    const result = await importer();
    expect(result.imported).toBe(0);
    expect(MARKER in files).toBe(true);
  });

  it('skips non-record entries and unreadable records', async () => {
    dirEntries = ['ser-1', 'ser-bad', 'index.json'];
    recordsByDir['/fake/data/pipeline-series/ser-1/index.json'] = rec('ser-1');
    recordsByDir['/fake/data/pipeline-series/ser-bad/index.json'] = null;
    const result = await importer();
    expect(result.imported).toBe(1);
    expect(table.has('ser-1')).toBe(true);
    expect(table.has('ser-bad')).toBe(false);
  });
});
