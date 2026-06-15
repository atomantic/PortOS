/**
 * Postgres-backed round-trip for the author personas DB adapter.
 *
 * Like the other `*.db.test.js` suites, needs a live PostgreSQL with the schema
 * applied; SKIPS cleanly when no test DB is reachable (the `query()` backstop in
 * lib/db.js refuses row writes to the real `portos` DB under the test runner, so
 * these DELETE/INSERT statements can NEVER corrupt the user's real authors —
 * this suite only runs via `npm run test:db` against `portos_test`).
 *
 * Snapshots + restores the `authors` table so a developer's real personas
 * survive the run even on the test DB.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'authors') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'authors table not present';
  }
}

if (!dbReady) console.log(`⏭️  services/authors/db.test.js skipped: ${skipReason}`);

describe.skipIf(!dbReady)('authors DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM authors`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM authors`); });

  afterAll(async () => {
    // Restore the developer's real personas: clear the test rows, re-insert the
    // snapshot. ON CONFLICT DO NOTHING so a partially-restored run is idempotent.
    await query(`DELETE FROM authors`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO authors (id, name, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.name, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('creates an author and mirrors name into the queryable column', async () => {
    const a = await db.createAuthor({ name: 'Ada Lovelace', bio: 'analytical' });
    expect(a.id).toMatch(/^auth-/);
    const col = (await query(`SELECT name, deleted FROM authors WHERE id = $1`, [a.id])).rows[0];
    expect(col.name).toBe('Ada Lovelace');
    expect(col.deleted).toBe(false);
    // data JSONB round-trips the full record verbatim.
    expect(await db.getAuthor(a.id)).toEqual(a);
  });

  it('listAuthors excludes tombstones; getAuthor returns null for a deleted id', async () => {
    const live = await db.createAuthor({ name: 'Live' });
    const dead = await db.createAuthor({ name: 'Dead' });
    await db.deleteAuthor(dead.id);
    const ids = (await db.listAuthors()).map((a) => a.id);
    expect(ids).toEqual([live.id]);
    expect(await db.getAuthor(dead.id)).toBeNull();
    // includeDeleted surfaces the tombstone (used by the peer-sync push path).
    expect((await db.getAuthor(dead.id, { includeDeleted: true })).deleted).toBe(true);
  });

  it('listAuthorIds reports live ids, and all ids with includeDeleted', async () => {
    const live = await db.createAuthor({ name: 'Live' });
    const dead = await db.createAuthor({ name: 'Dead' });
    await db.deleteAuthor(dead.id);
    expect(await db.listAuthorIds()).toEqual([live.id]);
    expect((await db.listAuthorIds({ includeDeleted: true })).sort()).toEqual([live.id, dead.id].sort());
  });

  it('updateAuthor bumps updatedAt and applies a partial patch (absent keys preserved)', async () => {
    const a = await db.createAuthor({ name: 'Original', bio: 'keep me' });
    const next = await db.updateAuthor(a.id, { name: 'Renamed' });
    expect(next.name).toBe('Renamed');
    expect(next.bio).toBe('keep me'); // absent key preserved
    expect(new Date(next.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(a.updatedAt).getTime());
    const col = (await query(`SELECT name FROM authors WHERE id = $1`, [a.id])).rows[0];
    expect(col.name).toBe('Renamed');
  });

  describe('mergeAuthorsFromSync (federated LWW)', () => {
    it('inserts a brand-new remote author verbatim', async () => {
      const remote = {
        id: 'auth-remote-1', name: 'Peer Author', writingStyle: 'terse',
        bio: '', physicalDescription: '', headshotStyle: '', headshotImageUrl: '',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        deleted: false, deletedAt: null,
      };
      const res = await db.mergeAuthorsFromSync([remote]);
      expect(res).toEqual({ applied: true, count: 1 });
      expect(await db.getAuthor('auth-remote-1')).toEqual(remote);
    });

    it('newer remote updatedAt overwrites local (LWW); older loses', async () => {
      const a = await db.createAuthor({ name: 'Local' });
      // Older remote → local wins (no change).
      const older = { ...a, name: 'Stale', updatedAt: '2000-01-01T00:00:00.000Z' };
      expect(await db.mergeAuthorsFromSync([older])).toEqual({ applied: false, count: 0 });
      expect((await db.getAuthor(a.id)).name).toBe('Local');
      // Newer remote → remote wins.
      const newer = { ...a, name: 'Fresh', updatedAt: '2099-01-01T00:00:00.000Z' };
      expect(await db.mergeAuthorsFromSync([newer])).toEqual({ applied: true, count: 1 });
      expect((await db.getAuthor(a.id)).name).toBe('Fresh');
    });

    it('a newer remote tombstone deletes a live local record', async () => {
      const a = await db.createAuthor({ name: 'Doomed' });
      const tombstone = { ...a, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
      expect(await db.mergeAuthorsFromSync([tombstone])).toEqual({ applied: true, count: 1 });
      expect(await db.getAuthor(a.id)).toBeNull();
      expect((await db.getAuthor(a.id, { includeDeleted: true })).deleted).toBe(true);
    });

    it('drops a malformed remote (no name) without applying', async () => {
      const res = await db.mergeAuthorsFromSync([{ id: 'auth-bad', name: '' }]);
      expect(res).toEqual({ applied: false, count: 0 });
      expect(await db.getAuthor('auth-bad', { includeDeleted: true })).toBeNull();
    });
  });

  describe('pruneTombstonedAuthors', () => {
    it('hard-removes tombstones older than the cutoff, keeps newer + live', async () => {
      const live = await db.createAuthor({ name: 'Live' });
      const oldDead = await db.createAuthor({ name: 'OldDead' });
      const newDead = await db.createAuthor({ name: 'NewDead' });
      await db.mergeAuthorsFromSync([
        { ...oldDead, deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' },
        { ...newDead, deleted: true, deletedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-02T00:00:00.000Z' },
      ]);
      const cutoff = Date.parse('2030-01-01T00:00:00.000Z');
      const { pruned } = await db.pruneTombstonedAuthors(cutoff);
      expect(pruned).toBe(1);
      const remaining = (await query(`SELECT id FROM authors ORDER BY id`)).rows.map((r) => r.id);
      expect(remaining.sort()).toEqual([live.id, newDead.id].sort());
    });

    it('is a no-op for a non-finite cutoff', async () => {
      await db.createAuthor({ name: 'X' });
      expect(await db.pruneTombstonedAuthors(NaN)).toEqual({ pruned: 0 });
    });
  });
});
