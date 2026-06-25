/**
 * Postgres-backed round-trip for the music-track DB adapter. SKIPS cleanly when
 * no test DB is reachable; runs only via `npm run test:db` against `portos_test`.
 * Snapshots + restores the `tracks` table. Mirrors albums/db.test.js.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'tracks') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'tracks table not present';
  }
}

if (!dbReady) console.log(`⏭️  services/tracks/db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('tracks DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM tracks`)).rows;
  });
  beforeEach(async () => { await query(`DELETE FROM tracks`); });
  afterAll(async () => {
    await query(`DELETE FROM tracks`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO tracks (id, title, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.title, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('creates a track and mirrors title into the column', async () => {
    const t = await db.createTrack({ title: 'Intro', engine: 'acestep', audioFilename: 'music-1.mp3' });
    expect(t.id).toMatch(/^track-/);
    const col = (await query(`SELECT title FROM tracks WHERE id = $1`, [t.id])).rows[0];
    expect(col.title).toBe('Intro');
    expect(await db.getTrack(t.id)).toEqual(t);
  });

  it('listTracks excludes tombstones; update preserves absent keys', async () => {
    const live = await db.createTrack({ title: 'Live' });
    const dead = await db.createTrack({ title: 'Dead' });
    await db.deleteTrack(dead.id);
    expect((await db.listTracks()).map((t) => t.id)).toEqual([live.id]);
    const next = await db.updateTrack(live.id, { prompt: 'warm' });
    expect(next.title).toBe('Live');
    expect(next.prompt).toBe('warm');
  });

  it('mergeTracksFromSync: newer wins, older loses', async () => {
    const t = await db.createTrack({ title: 'Local' });
    expect(await db.mergeTracksFromSync([{ ...t, title: 'Old', updatedAt: '2000-01-01T00:00:00.000Z' }])).toEqual({ applied: false, count: 0 });
    expect(await db.mergeTracksFromSync([{ ...t, title: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' }])).toEqual({ applied: true, count: 1 });
    expect((await db.getTrack(t.id)).title).toBe('Fresh');
  });
});
