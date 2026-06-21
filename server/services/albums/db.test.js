/**
 * Postgres-backed round-trip for the music-album DB adapter. SKIPS cleanly when
 * no test DB is reachable; runs only via `npm run test:db` against `portos_test`.
 * Snapshots + restores the `albums` table. Mirrors artists/db.test.js.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';

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

describe.skipIf(!dbReady)('albums DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM albums`)).rows;
  });
  beforeEach(async () => { await query(`DELETE FROM albums`); });
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

  it('pruneTombstonedAlbums removes old tombstones only', async () => {
    const live = await db.createAlbum({ title: 'Live' });
    const dead = await db.createAlbum({ title: 'Dead' });
    await db.mergeAlbumsFromSync([{ ...dead, deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' }]);
    expect((await db.pruneTombstonedAlbums(Date.parse('2030-01-01T00:00:00.000Z'))).pruned).toBe(1);
    expect((await query(`SELECT id FROM albums`)).rows.map((r) => r.id)).toEqual([live.id]);
  });
});
