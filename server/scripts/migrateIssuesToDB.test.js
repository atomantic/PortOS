/**
 * Tests for the legacy data/pipeline-issues/{id}/index.json → Postgres importer
 * (#1015). Issue dirs hold only index.json (no siblings), so the whole legacy
 * dir is renamed aside after rows land — like the universe importer. Disk + PG
 * are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let files = {};
let dirEntries = null;
let recordsByDir = {};
let renameShouldFail = false;
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
  rename: vi.fn(async (from, to) => {
    if (renameShouldFail) throw new Error('EACCES');
    renamed.push([from, to]);
  }),
  readdir: vi.fn(async () => (dirEntries === null ? [] : dirEntries)),
  stat: vi.fn(async (path) => {
    if (path === '/fake/data/pipeline-issues') {
      if (dirEntries === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => true };
    }
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }),
}));

let table;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO pipeline_issues/.test(sql)) {
    const id = params[0];
    if (table.has(id)) return { rowCount: 0, rows: [] };
    table.set(id, { id, seriesId: params[1], number: params[3], data: JSON.parse(params[5]) });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const MARKER = '/fake/data/pipeline-issues.migrated.json';
const rec = (id, extra = {}) => ({ id, seriesId: 'ser-1', number: 1, title: id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra });

async function importer() {
  const { migrateIssuesToDB } = await import('./migrateIssuesToDB.js');
  return migrateIssuesToDB();
}

beforeEach(() => {
  files = {};
  dirEntries = null;
  recordsByDir = {};
  renameShouldFail = false;
  renamed = [];
  table = new Map();
  query.mockClear();
});

describe('migrateIssuesToDB', () => {
  it('fresh install (no legacy dir): no-op WITHOUT a marker', async () => {
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    expect(MARKER in files).toBe(false);
  });

  it('marker already present: no-op', async () => {
    files[MARKER] = JSON.stringify({ reason: 'imported' });
    dirEntries = ['iss-1'];
    recordsByDir['/fake/data/pipeline-issues/iss-1/index.json'] = rec('iss-1');
    const result = await importer();
    expect(result).toMatchObject({ reason: 'already-applied' });
    expect(table.size).toBe(0);
  });

  it('imports records verbatim, renames the dir aside, stamps marker', async () => {
    dirEntries = ['iss-1', 'iss-2', 'index.json', '.DS_Store'];
    recordsByDir['/fake/data/pipeline-issues/iss-1/index.json'] = rec('iss-1', { number: 2, stages: { idea: { output: 'x' } } });
    recordsByDir['/fake/data/pipeline-issues/iss-2/index.json'] = rec('iss-2');
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(table.get('iss-1').data.stages.idea.output).toBe('x'); // verbatim
    expect(table.get('iss-1').number).toBe(2); // mirror column
    expect(renamed).toEqual([['/fake/data/pipeline-issues', '/fake/data/pipeline-issues.imported']]);
    expect(MARKER in files).toBe(true);
  });

  it('skips a record missing seriesId', async () => {
    dirEntries = ['iss-1', 'iss-bad'];
    recordsByDir['/fake/data/pipeline-issues/iss-1/index.json'] = rec('iss-1');
    recordsByDir['/fake/data/pipeline-issues/iss-bad/index.json'] = { id: 'iss-bad', title: 'orphan' };
    const result = await importer();
    expect(result.imported).toBe(1);
    expect(table.has('iss-1')).toBe(true);
    expect(table.has('iss-bad')).toBe(false);
  });

  it('rename failure leaves the marker UNwritten so next boot retries', async () => {
    dirEntries = ['iss-1'];
    recordsByDir['/fake/data/pipeline-issues/iss-1/index.json'] = rec('iss-1');
    renameShouldFail = true;
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported-rename-failed', imported: 1 });
    expect(MARKER in files).toBe(false);
    expect(table.has('iss-1')).toBe(true);
  });
});
