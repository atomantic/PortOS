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
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
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
