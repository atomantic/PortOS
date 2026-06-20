/**
 * Postgres-backed round-trip for the music-artist DB adapter.
 *
 * Like the other `*.db.test.js` suites, needs a live PostgreSQL with the schema
 * applied; SKIPS cleanly when no test DB is reachable (the `query()` backstop in
 * lib/db.js refuses row writes to the real `portos` DB under the test runner, so
 * these DELETE/INSERT statements can NEVER corrupt real data — this suite only
 * runs via `npm run test:db` against `portos_test`).
 *
 * Snapshots + restores the `artists` table so a developer's real personas
 * survive the run even on the test DB. Mirrors authors/db.test.js.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'artists') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'artists table not present';
  }
}

if (!dbReady) console.log(`⏭️  services/artists/db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('artists DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM artists`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM artists`); });

  afterAll(async () => {
    await query(`DELETE FROM artists`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO artists (id, name, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.name, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('creates an artist and mirrors name into the queryable column', async () => {
    const a = await db.createArtist({ name: 'Nova', genre: 'dream pop' });
    expect(a.id).toMatch(/^artist-/);
    const col = (await query(`SELECT name, deleted FROM artists WHERE id = $1`, [a.id])).rows[0];
    expect(col.name).toBe('Nova');
    expect(col.deleted).toBe(false);
    expect(await db.getArtist(a.id)).toEqual(a);
  });

  it('listArtists excludes tombstones; getArtist returns null for a deleted id', async () => {
    const live = await db.createArtist({ name: 'Live' });
    const dead = await db.createArtist({ name: 'Dead' });
    await db.deleteArtist(dead.id);
    const ids = (await db.listArtists()).map((a) => a.id);
    expect(ids).toEqual([live.id]);
    expect(await db.getArtist(dead.id)).toBeNull();
    expect((await db.getArtist(dead.id, { includeDeleted: true })).deleted).toBe(true);
  });

  it('updateArtist bumps updatedAt and applies a partial patch (absent keys preserved)', async () => {
    const a = await db.createArtist({ name: 'Original', bio: 'keep me' });
    const next = await db.updateArtist(a.id, { name: 'Renamed' });
    expect(next.name).toBe('Renamed');
    expect(next.bio).toBe('keep me');
    expect(new Date(next.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(a.updatedAt).getTime());
  });

  describe('mergeArtistsFromSync (LWW)', () => {
    it('inserts a brand-new remote artist verbatim', async () => {
      const remote = {
        id: 'artist-remote-1', name: 'Peer Artist', genre: 'ambient', bio: '',
        musicalStyle: 'lush', physicalDescription: '', portraitStyle: '', portraitImageUrl: '',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        deleted: false, deletedAt: null,
      };
      expect(await db.mergeArtistsFromSync([remote])).toEqual({ applied: true, count: 1 });
      expect(await db.getArtist('artist-remote-1')).toEqual(remote);
    });

    it('newer remote updatedAt overwrites local (LWW); older loses', async () => {
      const a = await db.createArtist({ name: 'Local' });
      const older = { ...a, name: 'Stale', updatedAt: '2000-01-01T00:00:00.000Z' };
      expect(await db.mergeArtistsFromSync([older])).toEqual({ applied: false, count: 0 });
      expect((await db.getArtist(a.id)).name).toBe('Local');
      const newer = { ...a, name: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' };
      expect(await db.mergeArtistsFromSync([newer])).toEqual({ applied: true, count: 1 });
      expect((await db.getArtist(a.id)).name).toBe('Fresh');
    });

    it('a newer remote tombstone deletes a live local record', async () => {
      const a = await db.createArtist({ name: 'Doomed' });
      const tombstone = { ...a, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
      expect(await db.mergeArtistsFromSync([tombstone])).toEqual({ applied: true, count: 1 });
      expect(await db.getArtist(a.id)).toBeNull();
    });
  });

  describe('pruneTombstonedArtists', () => {
    it('hard-removes tombstones older than the cutoff, keeps newer + live', async () => {
      const live = await db.createArtist({ name: 'Live' });
      const oldDead = await db.createArtist({ name: 'OldDead' });
      const newDead = await db.createArtist({ name: 'NewDead' });
      await db.mergeArtistsFromSync([
        { ...oldDead, deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
        { ...newDead, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-02T00:00:00.000Z' },
      ]);
      const { pruned } = await db.pruneTombstonedArtists(Date.parse('2030-01-01T00:00:00.000Z'));
      expect(pruned).toBe(1);
      const remaining = (await query(`SELECT id FROM artists ORDER BY id`)).rows.map((r) => r.id);
      expect(remaining.sort()).toEqual([live.id, newDead.id].sort());
    });

    it('is a no-op for a non-finite cutoff', async () => {
      await db.createArtist({ name: 'X' });
      expect(await db.pruneTombstonedArtists(NaN)).toEqual({ pruned: 0 });
    });
  });
});
