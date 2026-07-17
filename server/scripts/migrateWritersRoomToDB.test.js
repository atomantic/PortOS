/**
 * Tests for the legacy data/writers-room file layout → Postgres importer
 * (#1017). Disk + PG are mocked. The key differences from the other importers:
 *   - The .md draft bodies are file-primary and must NOT be parked aside — only
 *     the JSON metadata files (folders.json, exercises.json, each manifest.json)
 *     are renamed to *.imported.json.
 *   - A work manifest's drafts[] decomposes into draft-version rows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const DATA = '/fake/data';
const ROOT = `${DATA}/writers-room`;
const WORKS = `${ROOT}/works`;
const MARKER = `${DATA}/writers-room.migrated.json`;

let files = {};          // path -> string content (for readFile/writeFile)
let jsonByPath = {};     // path -> parsed value (for readJSONFile)
let workDirs = [];       // entries under works/
let existingDirs = new Set();
let renamed = [];

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: DATA },
  readJSONFile: vi.fn(async (path, fallback) => (path in jsonByPath ? jsonByPath[path] : fallback)),
  safeJSONParse: vi.fn((content, fallback) => { try { return JSON.parse(content); } catch { return fallback; } }),
}));

// Marker I/O is delegated to migrationMarker.js; mock it against the same
// in-memory `files` map (the marker helper has its own unit test).
vi.mock('../lib/migrationMarker.js', () => ({
  markerExists: vi.fn(async (name) => (`${DATA}/${name}` in files)),
  writeMarker: vi.fn(async (name, payload) => { files[`${DATA}/${name}`] = JSON.stringify(payload, null, 2); }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (path) => {
    if (!(path in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return files[path];
  }),
  rename: vi.fn(async (from, to) => { renamed.push([from, to]); files[to] = files[from]; delete files[from]; }),
  readdir: vi.fn(async (path) => {
    if (path === WORKS) return workDirs;
    return [];
  }),
  stat: vi.fn(async (path) => {
    if (path === ROOT || path === WORKS) {
      if (existingDirs.has(path)) return { isDirectory: () => true };
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    }
    // For parkFileAside existence checks: the source exists if it's in `files`,
    // the .imported.json aside does not (unless renamed already).
    if (path in files) return { isFile: () => true };
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  }),
}));

const folders = new Map();
const works = new Map();
const drafts = new Map();
const exercises = new Map();

const query = vi.fn(async (sql, params) => {
  if (/INSERT INTO writers_room_folders/.test(sql)) {
    const id = params[0];
    if (folders.has(id)) return { rowCount: 0, rows: [] };
    folders.set(id, { id, parentId: params[1], name: params[2], sortOrder: params[3], data: JSON.parse(params[4]) });
    return { rowCount: 1, rows: [] };
  }
  if (/INSERT INTO writers_room_works/.test(sql)) {
    const id = params[0];
    if (works.has(id)) return { rowCount: 0, rows: [] };
    works.set(id, { id, folderId: params[1], title: params[2], pipelineSeriesId: params[6], data: JSON.parse(params[10]) });
    return { rowCount: 1, rows: [] };
  }
  if (/INSERT INTO writers_room_draft_versions/.test(sql)) {
    const id = params[0];
    if (drafts.has(id)) return { rowCount: 0, rows: [] };
    drafts.set(id, { id, workId: params[1], contentFile: params[3], data: JSON.parse(params[8]) });
    return { rowCount: 1, rows: [] };
  }
  if (/INSERT INTO writers_room_exercises/.test(sql)) {
    const id = params[0];
    if (exercises.has(id)) return { rowCount: 0, rows: [] };
    exercises.set(id, { id, workId: params[1], status: params[2], data: JSON.parse(params[3]) });
    return { rowCount: 1, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});
vi.mock('../lib/db.js', () => ({ query: (...a) => query(...a) }));

const draft = (id) => ({ id, label: 'D', contentFile: `drafts/${id}.md`, contentHash: 'h', wordCount: 1, segmentIndex: [], createdAt: '2026-01-01T00:00:00.000Z' });
const manifest = (id, extra = {}) => ({ id, title: id, kind: 'short-story', status: 'drafting', activeDraftVersionId: 'wr-draft-a', drafts: [draft('wr-draft-a')], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra });

async function importer() {
  const { migrateWritersRoomToDB } = await import('./migrateWritersRoomToDB.js');
  return migrateWritersRoomToDB();
}

beforeEach(() => {
  files = {};
  jsonByPath = {};
  workDirs = [];
  existingDirs = new Set();
  renamed = [];
  folders.clear(); works.clear(); drafts.clear(); exercises.clear();
  query.mockClear();
});

describe('migrateWritersRoomToDB', () => {
  it('fresh install (no writers-room dir): no-op WITHOUT a marker', async () => {
    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'fresh-install' });
    expect(MARKER in files).toBe(false);
  });

  it('marker already present: no-op', async () => {
    files[MARKER] = JSON.stringify({ reason: 'imported' });
    existingDirs.add(ROOT);
    jsonByPath[`${ROOT}/folders.json`] = [{ id: 'wr-folder-1', name: 'X' }];
    const result = await importer();
    expect(result).toMatchObject({ reason: 'already-applied' });
    expect(folders.size).toBe(0);
  });

  it('imports folders, works (+ decomposed drafts), exercises; parks ONLY JSON aside', async () => {
    existingDirs.add(ROOT);
    existingDirs.add(WORKS);
    jsonByPath[`${ROOT}/folders.json`] = [{ id: 'wr-folder-1', name: 'Novels', sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' }];
    jsonByPath[`${ROOT}/exercises.json`] = [{ id: 'wr-ex-1', workId: 'wr-work-1', status: 'finished', startedAt: '2026-01-01T00:00:00.000Z' }];
    files[`${ROOT}/folders.json`] = '[]';
    files[`${ROOT}/exercises.json`] = '[]';
    workDirs = [
      { name: 'wr-work-1', isDirectory: () => true },
      { name: '.DS_Store', isDirectory: () => false },
    ];
    files[`${WORKS}/wr-work-1/manifest.json`] = JSON.stringify(manifest('wr-work-1', {
      pipelineSeriesId: 'ser-1',
      drafts: [draft('wr-draft-a'), draft('wr-draft-b')],
    }));

    const result = await importer();
    expect(result).toMatchObject({ ok: true, reason: 'imported', folders: 1, works: 1, exercises: 1 });

    // Rows landed.
    expect(folders.get('wr-folder-1').name).toBe('Novels');
    expect(exercises.get('wr-ex-1').status).toBe('finished');
    expect(works.get('wr-work-1').pipelineSeriesId).toBe('ser-1'); // mirror column
    expect(works.get('wr-work-1').data.drafts).toBeUndefined();    // drafts[] stripped from work row
    expect([...drafts.keys()].sort()).toEqual(['wr-draft-a', 'wr-draft-b']); // decomposed

    // ONLY the JSON metadata is parked aside — never the .md bodies.
    const renamedFrom = renamed.map(([from]) => from);
    expect(renamedFrom).toContain(`${ROOT}/folders.json`);
    expect(renamedFrom).toContain(`${ROOT}/exercises.json`);
    expect(renamedFrom).toContain(`${WORKS}/wr-work-1/manifest.json`);
    expect(renamed.every(([from]) => from.endsWith('.json'))).toBe(true);
    expect(renamed.some(([from]) => from.endsWith('.md'))).toBe(false);

    expect(MARKER in files).toBe(true);
  });

  it('skips a corrupted manifest (leaves it on disk), still imports the rest', async () => {
    existingDirs.add(ROOT);
    existingDirs.add(WORKS);
    workDirs = [
      { name: 'wr-work-aaa', isDirectory: () => true },
      { name: 'wr-work-bbb', isDirectory: () => true },
    ];
    files[`${WORKS}/wr-work-aaa/manifest.json`] = JSON.stringify(manifest('wr-work-aaa'));
    files[`${WORKS}/wr-work-bbb/manifest.json`] = '{ not valid json';
    const result = await importer();
    expect(result.works).toBe(1);
    expect(works.has('wr-work-aaa')).toBe(true);
    expect(works.has('wr-work-bbb')).toBe(false);
    // The corrupted manifest is NOT parked aside.
    expect(renamed.some(([from]) => from === `${WORKS}/wr-work-bbb/manifest.json`)).toBe(false);
  });

  it('re-import is idempotent (ON CONFLICT DO NOTHING)', async () => {
    works.set('wr-work-1', { id: 'wr-work-1' }); // pretend already imported
    existingDirs.add(ROOT);
    existingDirs.add(WORKS);
    workDirs = [{ name: 'wr-work-1', isDirectory: () => true }];
    files[`${WORKS}/wr-work-1/manifest.json`] = JSON.stringify(manifest('wr-work-1'));
    const result = await importer();
    expect(result.works).toBe(0); // conflict → not counted as newly imported
  });
});
