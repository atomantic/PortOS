// Regression: partial imports must survive repair/retry without replacing newer
// DB rows. Real temporary filesystem, DB double only; never a live database.
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

let dataDir;
const tables = new Map();
vi.mock('../lib/fileUtils.js', () => ({ PATHS: { get data() { return dataDir; } } }));
vi.mock('../lib/migrationMarker.js', () => ({
  markerExists: async name => stat(join(dataDir, name)).then(() => true, () => false),
  writeMarker: async (name, body) => writeFile(join(dataDir, name), JSON.stringify(body)),
}));
const db = vi.fn(async (sql, params) => {
  const table = /(?:INSERT INTO|FROM) (\w+)/.exec(sql)?.[1];
  if (!table) throw new Error('Unexpected test query');
  if (!tables.has(table)) tables.set(table, new Map());
  const rows = tables.get(table);
  if (sql.startsWith('SELECT')) return { rows: rows.has(params[0]) ? [{ id: params[0] }] : [] };
  expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
  if (rows.has(params[0])) return { rowCount: 0 };
  rows.set(params[0], params);
  return { rowCount: 1 };
});
vi.mock('../lib/db.js', () => ({ query: (...args) => db(...args), close: vi.fn() }));

import { migrateSeriesToDB } from './migrateSeriesToDB.js';
import { migrateIssuesToDB } from './migrateIssuesToDB.js';
import { migrateStoryBuilderToDB } from './migrateStoryBuilderToDB.js';
import { migrateUniversesToDB } from './migrateUniversesToDB.js';
import { migrateWritersRoomToDB } from './migrateWritersRoomToDB.js';
import { recoverLegacyImports, parseRecoveryArgs } from './recoverLegacyImports.js';

const exists = path => stat(join(dataDir, path)).then(() => true, () => false);
async function put(path, body) {
  await mkdir(dirname(join(dataDir, path)), { recursive: true });
  await writeFile(join(dataDir, path), typeof body === 'string' ? body : JSON.stringify(body));
}
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'legacy-retry-')); tables.clear(); db.mockClear(); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

it.each([
  ['pipeline-series', 'ser', 'pipeline_series', migrateSeriesToDB],
  ['pipeline-issues', 'iss', 'pipeline_issues', migrateIssuesToDB],
  ['story-builder', 'stb', 'story_builder_sessions', migrateStoryBuilderToDB],
  ['universes', 'uni', 'universes', migrateUniversesToDB],
])('%s imports healthy rows, retains damaged sources, then repairs without overwriting DB edits', async (domain, prefix, table, migrate) => {
  const good = `${prefix}-good`, bad = `${prefix}-bad`;
  await put(`${domain}/${good}/index.json`, { id: good, seriesId: 'ser-parent' });
  await put(`${domain}/${bad}/index.json`, '{');
  const first = await migrate();
  expect(first).toMatchObject({ reason: 'incomplete', imported: 1 });
  expect(await exists(`${domain}.migrated.json`)).toBe(false);
  expect(await exists(`${domain}/${bad}/index.json`)).toBe(true);
  expect(await exists(`${domain}.imported`)).toBe(false);
  tables.get(table).set(good, 'newer database edit');
  await put(`${domain}/${bad}/index.json`, { id: bad, seriesId: 'ser-parent' });
  expect(await migrate()).toMatchObject({ reason: 'imported', imported: 1 });
  expect(tables.get(table).get(good)).toBe('newer database edit');
  expect(tables.get(table).has(bad)).toBe(true);
  expect(await exists(`${domain}.migrated.json`)).toBe(true);
});

it.each(['folders', 'exercises', 'manifest', 'draft'])('Writers Room keeps invalid %s retryable and preserves prose', async invalid => {
  const path = invalid === 'folders' || invalid === 'exercises'
    ? `writers-room/${invalid}.json` : 'writers-room/works/wr-work-bbb/manifest.json';
  const repaired = invalid === 'folders' || invalid === 'exercises'
    ? [{ id: `wr-${invalid}-bbb` }] : { id: 'wr-work-bbb', drafts: [{ id: 'wr-draft-bbb' }] };
  await put(path, invalid === 'draft' ? { id: 'wr-work-bbb', drafts: [{}] } : '{');
  await put('writers-room/works/wr-work-aaa/manifest.json', { id: 'wr-work-aaa' });
  await put('writers-room/works/wr-work-aaa/drafts/wr-draft-aaa.md', 'Original prose');
  expect(await migrateWritersRoomToDB()).toMatchObject({ reason: 'incomplete', works: 1 });
  expect(await exists('writers-room.migrated.json')).toBe(false);
  expect(await exists(path)).toBe(true);
  tables.get('writers_room_works').set('wr-work-aaa', 'newer edit');
  await put(path, repaired);
  expect(await migrateWritersRoomToDB()).toMatchObject({ reason: 'imported' });
  expect(tables.get('writers_room_works').get('wr-work-aaa')).toBe('newer edit');
  expect(await readFile(join(dataDir, 'writers-room/works/wr-work-aaa/drafts/wr-draft-aaa.md'), 'utf8')).toBe('Original prose');
});

it('retains canonical metadata when a recovery copy prevents parking', async () => {
  await put('pipeline-series/ser-a/index.json', { id: 'ser-a' });
  await put('pipeline-series/ser-a/index.json.imported', { id: 'ser-a', name: 'old recovery' });
  await put('pipeline-series/ser-a/manuscript-review.json', { review: 'file primary' });
  expect(await migrateSeriesToDB()).toMatchObject({ reason: 'incomplete' });
  expect(await exists('pipeline-series.migrated.json')).toBe(false);
  expect(await exists('pipeline-series/ser-a/index.json')).toBe(true);
  expect(JSON.parse(await readFile(join(dataDir, 'pipeline-series/ser-a/index.json.imported'), 'utf8')).name).toBe('old recovery');
  expect(await exists('pipeline-series/ser-a/manuscript-review.json')).toBe(true);
});

it('blocks completion on a damaged universe runs index until repair', async () => {
  await put('universes/index.json', '{');
  expect(await migrateUniversesToDB()).toMatchObject({ reason: 'incomplete' });
  await put('universes/index.json', { config: { runs: [{ id: 'run-a', universeId: 'uni-a' }] } });
  expect(await migrateUniversesToDB()).toMatchObject({ reason: 'imported', runs: 1 });
});

it('does not misreport an invalid directory as a fresh installation', async () => {
  await put('pipeline-series', 'not a directory');
  await expect(migrateSeriesToDB()).rejects.toThrow('not a directory');
  expect(await exists('pipeline-series.migrated.json')).toBe(false);
});

it('recovery dry-run inspects canonical and parked sources, applies only selected missing rows, and preserves markers', async () => {
  await put('pipeline-series.migrated.json', { reason: 'imported' });
  await put('pipeline-series/ser-a/index.json', { id: 'ser-a', name: 'repaired' });
  await put('pipeline-series/ser-a/index.json.imported', { id: 'ser-a', name: 'old' });
  await put('pipeline-issues.imported/iss-a/index.json', { id: 'iss-a', seriesId: 'ser-a' });
  await put('universes.imported/uni-old/index.json', { id: 'uni-old' });
  await put('writers-room/works/wr-work-aaa/manifest.imported.json', { id: 'wr-work-aaa', drafts: [{ id: 'wr-draft-aaa' }] });
  const preview = await recoverLegacyImports();
  expect(preview.mode).toBe('dry-run');
  expect(preview.results.map(row => row.key)).toEqual(expect.arrayContaining(['series:ser-a', 'issue:iss-a', 'universe:uni-old', 'work:wr-work-aaa', 'draft:wr-draft-aaa']));
  expect(db.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  tables.get('pipeline_series').set('ser-a', 'newer DB edit');
  const applied = await recoverLegacyImports({ apply: true, selections: ['series:ser-a', 'issue:iss-a', 'work:wr-work-aaa'] });
  expect(applied.results).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'series:ser-a', status: 'exists' }), expect.objectContaining({ key: 'issue:iss-a', status: 'inserted' })]));
  expect(tables.get('pipeline_series').get('ser-a')).toBe('newer DB edit');
  expect(tables.get('universes').size).toBe(0);
  expect(tables.get('writers_room_draft_versions').size).toBe(0); // selecting work does NOT resurrect deleted drafts
  expect(await exists('pipeline-series.migrated.json')).toBe(true);
  expect(await exists('pipeline-issues.imported/iss-a/index.json')).toBe(true);
  expect((await recoverLegacyImports({ selections: ['series:unknown'] })).results).toContainEqual({ key: 'series:unknown', status: 'not-found' });
});

it('refuses unscoped apply and unknown recovery arguments before DB access', async () => {
  expect(parseRecoveryArgs(['--id', 'series:ser-a', '--apply'])).toEqual({ apply: true, selections: ['series:ser-a'] });
  expect(() => parseRecoveryArgs(['--all'])).toThrow('Usage');
  await expect(recoverLegacyImports({ apply: true })).rejects.toThrow('explicit');
  await expect(recoverLegacyImports({ selections: ['unknown:record'] })).rejects.toThrow('kind:record-id');
  expect(db).not.toHaveBeenCalled();
});

it('accepts DB-native prose/review directories with no legacy metadata or marker', async () => {
  await put('writers-room/works/wr-work-aaa/drafts/wr-draft-aaa.md', 'DB-native prose');
  await put('pipeline-series/ser-a/manuscript-review.json', { review: 'DB-native review' });
  tables.set('writers_room_works', new Map([['wr-work-aaa', 'current work']]));
  tables.set('pipeline_series', new Map([['ser-a', 'current series']]));
  expect(await migrateWritersRoomToDB()).toMatchObject({ reason: 'imported', works: 0 });
  expect(await migrateSeriesToDB()).toMatchObject({ reason: 'imported', imported: 0 });
  expect(db.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  expect(await exists('writers-room/works/wr-work-aaa/drafts/wr-draft-aaa.md')).toBe(true);
  expect(await exists('pipeline-series/ser-a/manuscript-review.json')).toBe(true);
});
