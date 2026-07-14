/**
 * Tests for the legacy data/story-builder/{id}/index.json → Postgres importer
 * (#1016). Session dirs hold only index.json (no siblings), so the whole legacy
 * dir is renamed aside after rows land — like the pipeline-issues importer. Disk
 * + PG are mocked.
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
    if (path === '/fake/data/story-builder') {
      if (dirEntries === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => true };
    }
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }),
}));

let table;
const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO story_builder_sessions/.test(sql)) {
    const id = params[0];
    if (table.has(id)) return { rowCount: 0, rows: [] };
    table.set(id, { id, universeId: params[1], seriesId: params[2], sync: params[3], data: JSON.parse(params[4]) });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const MARKER = '/fake/data/story-builder.migrated.json';
const rec = (id, extra = {}) => ({ id, title: id, intakeMode: 'seed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra });

async function importer() {
  const { migrateStoryBuilderToDB } = await import('./migrateStoryBuilderToDB.js');
  return migrateStoryBuilderToDB();
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

describe('migrateStoryBuilderToDB', () => {
  it('fresh install (no legacy dir): no-op WITHOUT a marker', async () => {
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install', imported: 0 });
    expect(MARKER in files).toBe(false);
  });

  it('marker already present: no-op', async () => {
    files[MARKER] = JSON.stringify({ reason: 'imported' });
    dirEntries = ['stb-1'];
    recordsByDir['/fake/data/story-builder/stb-1/index.json'] = rec('stb-1');
    const result = await importer();
    expect(result).toMatchObject({ reason: 'already-applied' });
    expect(table.size).toBe(0);
  });

  it('imports records verbatim, renames the dir aside, stamps marker', async () => {
    dirEntries = ['stb-1', 'stb-2', 'index.json', '.DS_Store'];
    recordsByDir['/fake/data/story-builder/stb-1/index.json'] = rec('stb-1', { universeId: 'u-1', seriesId: 'ser-1', steps: { idea: { locked: true } } });
    recordsByDir['/fake/data/story-builder/stb-2/index.json'] = rec('stb-2');
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(table.get('stb-1').data.steps.idea.locked).toBe(true); // verbatim
    expect(table.get('stb-1').universeId).toBe('u-1'); // mirror column
    expect(table.get('stb-1').seriesId).toBe('ser-1'); // mirror column
    expect(renamed).toEqual([['/fake/data/story-builder', '/fake/data/story-builder.imported']]);
    expect(MARKER in files).toBe(true);
  });

  it('promotes the OPT-IN sync flag into the mirror column', async () => {
    dirEntries = ['stb-on', 'stb-off'];
    recordsByDir['/fake/data/story-builder/stb-on/index.json'] = rec('stb-on', { sync: true });
    recordsByDir['/fake/data/story-builder/stb-off/index.json'] = rec('stb-off', { sync: false });
    await importer();
    expect(table.get('stb-on').sync).toBe(true);
    expect(table.get('stb-off').sync).toBe(false);
  });

  it('skips an unreadable record', async () => {
    dirEntries = ['stb-1', 'stb-bad'];
    recordsByDir['/fake/data/story-builder/stb-1/index.json'] = rec('stb-1');
    recordsByDir['/fake/data/story-builder/stb-bad/index.json'] = null;
    const result = await importer();
    expect(result.imported).toBe(1);
    expect(table.has('stb-1')).toBe(true);
    expect(table.has('stb-bad')).toBe(false);
  });

  it('rename failure leaves the marker UNwritten so next boot retries', async () => {
    dirEntries = ['stb-1'];
    recordsByDir['/fake/data/story-builder/stb-1/index.json'] = rec('stb-1');
    renameShouldFail = true;
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported-rename-failed', imported: 1 });
    expect(MARKER in files).toBe(false);
    expect(table.has('stb-1')).toBe(true);
  });
});
