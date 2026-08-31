/**
 * Postgres-backed round-trip for the music-album DB adapter. SKIPS cleanly when
 * no test DB is reachable; runs only via `npm run test:db` against `portos_test`.
 * Snapshots + restores the `albums` table. Mirrors artists/db.test.js.
 */

import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { getSyncBaseHash, __resetBaseHashCacheForTests } from '../../lib/conflictJournal.js';

const testState = vi.hoisted(() => ({ dataRoot: null, writeCounter: { baseHash: 0 } }));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  testState.dataRoot ??= mkdtempSync(join(tmpdir(), 'albums-db-test-'));
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'albums') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'albums table not present';
  }
}

if (!dbReady) console.log(`⏭️  services/albums/db.test.js skipped: ${skipReason}`);

afterAll(() => rmSync(testState.dataRoot, { recursive: true, force: true }));

describe.skipIf(!dbReady)('albums DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM albums`)).rows;
  });
  beforeEach(async () => {
    await query(`DELETE FROM albums`);
    rmSync(join(testState.dataRoot, 'sharing'), { recursive: true, force: true });
    __resetBaseHashCacheForTests();
    testState.writeCounter.baseHash = 0;
  });
  afterAll(async () => {
    await query(`DELETE FROM albums`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO albums (id, title, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.title, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('creates an album and mirrors title into the column', async () => {
    const a = await db.createAlbum({ title: 'Debut', genre: 'folk', trackIds: ['track-1'] });
    expect(a.id).toMatch(/^album-/);
    const col = (await query(`SELECT title, deleted FROM albums WHERE id = $1`, [a.id])).rows[0];
    expect(col.title).toBe('Debut');
    expect(await db.getAlbum(a.id)).toEqual(a);
  });

  it('listAlbums excludes tombstones; update preserves absent keys', async () => {
    const live = await db.createAlbum({ title: 'Live' });
    const dead = await db.createAlbum({ title: 'Dead' });
    await db.deleteAlbum(dead.id);
    expect((await db.listAlbums()).map((a) => a.id)).toEqual([live.id]);
    const next = await db.updateAlbum(live.id, { genre: 'jazz' });
    expect(next.title).toBe('Live');
    expect(next.genre).toBe('jazz');
  });

  it('mergeAlbumsFromSync: newer wins, older loses, tombstone deletes', async () => {
    const a = await db.createAlbum({ title: 'Local' });
    expect(await db.mergeAlbumsFromSync([{ ...a, title: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }])).toEqual({ applied: false, count: 0 });
    expect(await db.mergeAlbumsFromSync([{ ...a, title: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' }])).toEqual({ applied: true, count: 1 });
    expect((await db.getAlbum(a.id)).title).toBe('Fresh');
    await db.mergeAlbumsFromSync([{ ...a, deleted: true, deletedAt: '2099-02-01T00:00:00.000Z', updatedAt: '2099-02-01T00:00:00.000Z' }]);
    expect(await db.getAlbum(a.id)).toBeNull();
  });

  it('pruneTombstonedAlbums batches multiple old tombstone base-hash evictions', async () => {
    const live = await db.createAlbum({ title: 'Live' });
    const dead = await db.createAlbum({ title: 'Dead' });
    const deadTwo = await db.createAlbum({ title: 'DeadTwo' });
    await db.mergeAlbumsFromSync([
      { ...dead, deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
      { ...deadTwo, deleted: true, deletedAt: '2020-01-02T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
    ]);
    expect(await getSyncBaseHash('album', dead.id)).not.toBeNull();
    expect(await getSyncBaseHash('album', deadTwo.id)).not.toBeNull();

    testState.writeCounter.baseHash = 0;
    expect(await db.pruneTombstonedAlbums(Date.parse('2030-01-01T00:00:00.000Z')))
      .toEqual({ pruned: 2 });
    expect(testState.writeCounter.baseHash).toBe(1);
    expect(await getSyncBaseHash('album', dead.id)).toBeNull();
    expect(await getSyncBaseHash('album', deadTwo.id)).toBeNull();
    expect((await query(`SELECT id FROM albums`)).rows.map((r) => r.id)).toEqual([live.id]);
  });
});
