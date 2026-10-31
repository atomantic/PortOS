/**
 * PostgreSQL-backed round-trip for the Music Video project store.
 *
 * This suite runs only through the dedicated test database config. It keeps the
 * fixture ids isolated and uses a temporary data root so the prune assertion
 * can verify the conflict-journal side-store write without touching a live
 * install's files.
 */

import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { captureMusicVideoEvidence, musicVideoDependencyImpact } from '../../lib/musicVideoDependencies.js';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import * as database from '../../lib/db.js';
import { toPgJson } from '../../lib/pgJson.js';
import { compareMusicVideoProjectsNewestFirst } from '../../lib/musicVideoSummary.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { getSyncBaseHash, __resetBaseHashCacheForTests } from '../../lib/conflictJournal.js';

const testState = vi.hoisted(() => ({ dataRoot: null, writeCounter: { baseHash: 0 } }));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  testState.dataRoot ??= mkdtempSync(join(tmpdir(), 'music-video-projects-db-test-'));
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: testState.dataRoot },
    atomicWrite: async (path, data) => {
      if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) testState.writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
  };
});

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'music_video_projects') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'music_video_projects table not present';
  }
}

const runDb = requireDbOrSkip('services/musicVideo/projectsDB.test', dbReady, skipReason);

afterAll(() => rmSync(testState.dataRoot, { recursive: true, force: true }));

const PRUNE_PREFIX = 'mv-issue-5532-prune-';
const project = (id, deletedAt) => ({
  id,
  name: id,
  status: 'draft',
  scenes: [],
  createdAt: deletedAt,
  updatedAt: deletedAt,
  deleted: true,
  deletedAt,
});

describe.skipIf(!runDb)('music video projects DB adapter', () => {
  let db;

  beforeAll(async () => { db = await import('./projectsDB.js'); });

  beforeEach(async () => {
    await query(`DELETE FROM music_video_projects`);
    rmSync(join(testState.dataRoot, 'sharing'), { recursive: true, force: true });
    rmSync(join(testState.dataRoot, 'conflict-journal'), { recursive: true, force: true });
    __resetBaseHashCacheForTests();
    testState.writeCounter.baseHash = 0;
  });

  afterAll(async () => {
    await query(`DELETE FROM music_video_projects WHERE id LIKE $1`, [`${PRUNE_PREFIX}%`]).catch(() => {});
    await close();
  });

  it('preserves a festival packet through PG saves, kit updates and legacy peer edits', async () => {
    const packet = { version: 1, fields: { title: 'Festival edition' }, rights: 'unknown', musicRights: 'unknown', consent: 'unknown', festivals: [], include: ['title'] };
    const created = await db.createProject({ name: 'Festival fixture', festivalPacket: packet });
    expect((await db.getProject(created.id)).festivalPacket).toEqual(packet);
    await db.updateProject(created.id, { name: 'Edited name' });
    await db.mutateProjectRecord(created.id, current => ({ project: { ...current, publishKit: { builtAt: '2026-01-01' } } }));
    const saved = await db.getProject(created.id);
    const { festivalPacket: _packet, ...legacy } = saved;
    await db.mergeProjectsFromSync([{ ...legacy, updatedAt: '2099-01-01T00:00:00.000Z' }]);
    expect((await db.getProject(created.id)).festivalPacket).toEqual(packet);
    await db.updateProject(created.id, { festivalPacket: { ...packet, fields: { title: 'Revised packet' } } });
    expect((await db.getProject(created.id)).festivalPacket.fields.title).toBe('Revised packet');
  });

  it('round-trips dependency evidence and selective invalidation through PostgreSQL and peer merge', async () => {
    const created = await db.createProject({ name: 'Example dependency record' });
    await db.updateProject(created.id, { scenes: [{ sceneId: 'a', startSec: 0, endSec: 5, referenceImageId: 'plate.png', videoHistoryId: null, takes: [] }] });
    await db.appendSceneTakes(created.id, 'a', [{ kind: 'video', assetId: 'clip-example', source: 'generated', sourceImageId: 'plate.png' }]);
    const before = await db.getProject(created.id);
    await db.mutateProjectRecord(created.id, (current) => ({ project: { ...current, excerpts: [{ id: 'excerpt-example', status: 'complete', dependencies: captureMusicVideoEvidence(before) }] } }));
    await db.updateScene(created.id, 'a', { referenceImageId: 'new-plate.png' });
    const stale = await db.getProject(created.id);
    expect(musicVideoDependencyImpact(stale).shots.map((shot) => shot.sceneId)).toEqual(['a']);
    expect(stale.excerpts[0].dependencies.version).toBe(1);
    const remote = { ...stale, id: 'mv-peer-example', updatedAt: '2099-01-01T00:00:00.000Z' };
    await db.mergeProjectsFromSync([remote]);
    const synced = await db.getProject(remote.id);
    expect(synced.scenes[0].takes[0].dependencies).toEqual(stale.scenes[0].takes[0].dependencies);
    expect(musicVideoDependencyImpact(synced).shots).toEqual(musicVideoDependencyImpact(stale).shots);
  });

  it('migrates legacy tool intent identically in PostgreSQL and files without replacing assets or timestamps', async () => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const { default: migration } = await import('../../../scripts/migrations/421-music-video-media-modes.js');
    const records = [
      { id: 'mv-migration-top-level', tools: ['code:render'] },
      { id: 'mv-migration-nested', automation: { tools: ['code:render'] } },
      { id: 'mv-migration-override', tools: ['code:render'], automation: { tools: ['image:local'] } },
      { id: 'mv-migration-explicit', mediaMode: 'code-images', tools: ['code:render'] },
    ].map((record) => ({ ...record, scenes: [{ referenceImageId: 'historical-example.png' }], updatedAt: '2026-01-01T00:00:00.000Z' }));
    const rootDir = join(testState.dataRoot, 'migration-fixture');
    const file = join(rootDir, 'data', 'music-video-projects.json');
    await mkdir(join(rootDir, 'data'), { recursive: true });
    await writeFile(file, JSON.stringify(records));
    for (const record of records) {
      await query(`INSERT INTO music_video_projects (id, status, data, created_at, updated_at)
        VALUES ($1, 'draft', $2::jsonb, $3, $3)`, [record.id, JSON.stringify(record), record.updatedAt]);
    }
    const { up: upDb } = await import('../../scripts/db-migrations/015-music-video-media-modes.js');
    await migration.up({ rootDir });
    await migration.up({ rootDir });
    await upDb({ query });
    await upDb({ query });
    const expected = records.map((record, index) => ({ ...record, mediaMode: ['code-only', 'code-only', 'code-images-video', 'code-images'][index] }));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected);
    for (const record of expected) {
      const { rows: [stored] } = await query('SELECT data, updated_at FROM music_video_projects WHERE id = $1', [record.id]);
      expect(stored.data).toEqual(record);
      expect(new Date(stored.updated_at).toISOString()).toBe(record.updatedAt);
    }
  });

  it('backfills a missing JSONB id from the primary-key column', async () => {
    const id = `${PRUNE_PREFIX}legacy-no-json-id`;
    await query(
      `INSERT INTO music_video_projects (id, status, data, created_at, updated_at, deleted)
       VALUES ($1, 'draft', $2::jsonb, now(), now(), FALSE)`,
      [id, JSON.stringify({ name: 'Legacy row', status: 'draft', scenes: [] })],
    );

    expect(await db.getProject(id)).toMatchObject({ id, name: 'Legacy row' });
    expect((await db.listProjects()).find((item) => item.name === 'Legacy row')?.id).toBe(id);
  });

  it('hydrates only a requested page while preserving legacy timestamp fallbacks and excluding tombstones', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ id: `mv-page-${i}`,
      createdAt: i === 19 ? null : `2026-01-${String(i + 1).padStart(2, '0')}`,
      updatedAt: `2026-02-${String(i + 1).padStart(2, '0')}`,
      composition: { document: { source: 'x'.repeat(128 * 1024) } } }));
    for (const record of records) {
      await query(`INSERT INTO music_video_projects (id, status, data, created_at, updated_at, deleted)
        VALUES ($1, 'draft', $2::jsonb, '2026-01-01', '2026-01-01', $3)`,
      [record.id, toPgJson(record), record.id === 'mv-page-18']);
    }
    const read = vi.spyOn(database, 'query');
    try {
      const all = await db.listProjects();
      const baselineCalls = [...read.mock.calls];
      read.mockClear();
      const expected = [...all].sort(compareMusicVideoProjectsNewestFirst);
      expect(expected[0].id).toBe('mv-page-19');
      const page = await db.listProjectPage({ limit: 1, offset: 0, compare: compareMusicVideoProjectsNewestFirst });
      expect(page).toEqual({ items: expected.slice(0, 1), total: 19, limit: 1, offset: 0 });
      const rows = (await Promise.all(read.mock.results.map(result => result.value))).flatMap(result => result.rows);
      expect(rows.filter(row => row.data).map(row => row.id)).toEqual([expected[0].id]);
      if (process.env.PORTOS_COLLECTION_BENCHMARK === '1') {
        process.stdout.write(JSON.stringify({ projects: all.length, fullBytes: Buffer.byteLength(toPgJson(all)),
          pageReadBytes: Buffer.byteLength(toPgJson(rows)), hydratedProjects: rows.filter(row => row.data).length }) + '\n');
        const calls = [...baselineCalls, ...read.mock.calls];
        for (const [sql, params] of calls) {
          const { rows: explained } = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
          const plan = explained[0]['QUERY PLAN'][0];
          process.stdout.write(JSON.stringify({ operation: sql.includes('ANY') ? 'page' : sql.includes('AS "createdAt"') ? 'headers' : 'full',
            node: plan.Plan['Node Type'], executionMs: plan['Execution Time'], rows: plan.Plan['Actual Rows'],
            tempReadBlocks: plan.Plan['Temp Read Blocks'], tempWrittenBlocks: plan.Plan['Temp Written Blocks'] }) + '\n');
        }
      }
      expect(await db.listProjectPage({ limit: 1, offset: 19, compare: compareMusicVideoProjectsNewestFirst }))
        .toEqual({ items: [], total: 19, limit: 1, offset: 19 });
      expect((await db.listProjectPage({ limit: 2, offset: 1 })).items).toEqual(all.slice(1, 3));
    } finally {
      read.mockRestore();
    }
  });

  it('lists live project names without the record bodies', async () => {
    const live = await db.createProject({ name: 'Example Video' });
    const gone = await db.createProject({ name: 'Deleted Video' });
    await db.deleteProject(gone.id);
    expect(await db.listProjectNames()).toEqual([{ id: live.id, name: 'Example Video' }]);
  });

  it('rejects persistence when the project id is missing', async () => {
    await expect(db.persist(query, { name: 'Missing id' })).rejects.toMatchObject({ code: 'PROJECT_ID_MISSING' });
  });

  it('rejects a mutator against a tombstoned project', async () => {
    const created = await db.createProject({ name: 'Doomed' });
    await db.deleteProject(created.id);
    await expect(db.updateProject(created.id, { name: 'Zombie' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('same-updatedAt re-push does not persist or rewrite the base hash', async () => {
    const remote = {
      id: `${PRUNE_PREFIX}same-timestamp`, name: 'Same', status: 'draft', scenes: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      deleted: false, deletedAt: null,
    };
    await db.mergeProjectsFromSync([remote]);
    const before = await query(`SELECT xmin::text AS version FROM music_video_projects WHERE id = $1`, [remote.id]);
    testState.writeCounter.baseHash = 0;

    expect(await db.mergeProjectsFromSync([remote])).toEqual({ applied: false, count: 0 });
    const after = await query(`SELECT xmin::text AS version FROM music_video_projects WHERE id = $1`, [remote.id]);
    expect(after.rows[0].version).toBe(before.rows[0].version);
    expect(testState.writeCounter.baseHash).toBe(0);
  });

  it('pruneTombstonedProjects batches base-hash eviction for multiple tombstones', async () => {
    const oldOne = project(`${PRUNE_PREFIX}old-1`, '2000-01-01T00:00:00.000Z');
    const oldTwo = project(`${PRUNE_PREFIX}old-2`, '2000-01-02T00:00:00.000Z');
    const newer = project(`${PRUNE_PREFIX}new`, '2099-01-01T00:00:00.000Z');
    await db.mergeProjectsFromSync([oldOne, oldTwo, newer]);
    expect(await getSyncBaseHash('musicVideoProject', oldOne.id)).not.toBeNull();
    expect(await getSyncBaseHash('musicVideoProject', oldTwo.id)).not.toBeNull();

    testState.writeCounter.baseHash = 0;
    const result = await db.pruneTombstonedProjects(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(result).toEqual({ pruned: 2 });
    expect(testState.writeCounter.baseHash).toBe(1);
    __resetBaseHashCacheForTests();
    expect(await getSyncBaseHash('musicVideoProject', oldOne.id)).toBeNull();
    expect(await getSyncBaseHash('musicVideoProject', oldTwo.id)).toBeNull();
    expect(await db.getProject(newer.id, { includeDeleted: true })).not.toBeNull();
    expect(await db.getProject(oldOne.id, { includeDeleted: true })).toBeNull();
  });
});
