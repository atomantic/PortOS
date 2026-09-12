/**
 * Postgres-backed round-trip for the pipeline series DB adapter (#1015).
 *
 * Like universeBuilder/db.test.js, needs a live PostgreSQL with the schema
 * applied; SKIPS cleanly when no DB is reachable. Snapshots + restores the table
 * so a developer's real series survive the run.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../../lib/db.js';
import { requireDbOrSkip } from '../../../lib/dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pipeline_series') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'pipeline_series table not present';
  }
}

const runDb = requireDbOrSkip('services/pipeline/seriesStore/db.test', dbReady, skipReason);

const S = (id, extra = {}) => ({
  id, name: id, universeId: null, writersRoomWorkId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!runDb)('pipeline series DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM pipeline_series`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM pipeline_series`); });

  afterAll(async () => {
    await query(`DELETE FROM pipeline_series`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO pipeline_series (id, name, universe_id, writers_room_work_id, data, ephemeral, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.name, r.universe_id, r.writers_room_work_id, JSON.stringify(r.data), r.ephemeral, r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });


  it('projects names and summary fields without transporting full arc or seasons', async () => {
    await db.writeRaw('ser-live', S('ser-live', {
      universeId: 'u-test', logline: 'A city', coverImage: 'cover.png', issueCountTarget: 4,
      arc: { shape: 'man-in-hole', summary: 'Full arc' }, seasons: [{ name: 'Full season' }],
    }));
    await db.writeRaw('ser-deleted', S('ser-deleted', { deleted: true }));
    const names = await db.listNames();
    expect(names).toEqual([{ id: 'ser-live', name: 'ser-live', updatedAt: '2026-01-02T00:00:00.000Z' }]);
    const summaries = await db.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      universeId: 'u-test', logline: 'A city', coverImage: 'cover.png', issueCountTarget: 4,
      arc: { shape: 'man-in-hole' },
    });
    expect(summaries[0]).not.toHaveProperty('seasons');
    expect(summaries[0]).not.toHaveProperty('data');
  });

  it('writes a record and reads it back verbatim', async () => {
    const rec = S('ser-1', { universeId: 'u-1', seasons: [{ id: 'sea-1', number: 1 }], arc: { logline: 'x' } });
    await db.writeRaw('ser-1', rec);
    expect(await db.readRaw('ser-1')).toEqual(rec);
  });

  it('upsert updates the record and the mirror columns', async () => {
    await db.writeRaw('ser-1', S('ser-1', { name: 'First', universeId: 'u-1' }));
    await db.writeRaw('ser-1', S('ser-1', { name: 'Renamed', universeId: 'u-2', updatedAt: '2026-03-03T00:00:00.000Z' }));
    const col = (await query(`SELECT name, universe_id, updated_at FROM pipeline_series WHERE id = 'ser-1'`)).rows[0];
    expect(col.name).toBe('Renamed');
    expect(col.universe_id).toBe('u-2');
    expect(new Date(col.updated_at).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('idx_series_universe serves "live series in a universe" (the delete-guard query)', async () => {
    await db.writeRaw('ser-1', S('ser-1', { universeId: 'u-1' }));
    await db.writeRaw('ser-2', S('ser-2', { universeId: 'u-1', deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ser-3', S('ser-3', { universeId: 'u-2' }));
    const live = (await query(`SELECT id FROM pipeline_series WHERE universe_id = 'u-1' AND deleted = FALSE`)).rows;
    expect(live.map((r) => r.id)).toEqual(['ser-1']);
  });

  it('listIds returns live, tombstoned, and ephemeral ids alike', async () => {
    await db.writeRaw('ser-live', S('ser-live'));
    await db.writeRaw('ser-dead', S('ser-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ser-ghost', S('ser-ghost', { ephemeral: true }));
    expect((await db.listIds()).sort()).toEqual(['ser-dead', 'ser-ghost', 'ser-live']);
  });

  it('listLiveIds returns only non-deleted ids', async () => {
    await db.writeRaw('ser-live', S('ser-live'));
    await db.writeRaw('ser-dead', S('ser-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ser-ghost', S('ser-ghost', { ephemeral: true }));
    expect((await db.listLiveIds()).sort()).toEqual(['ser-ghost', 'ser-live']);
  });

  it('listTombstoneIdsBefore returns only tombstones older than the cutoff, keeping a NULL deleted_at', async () => {
    await db.writeRaw('ser-live', S('ser-live'));
    await db.writeRaw('ser-old', S('ser-old', { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' }));
    await db.writeRaw('ser-new', S('ser-new', { deleted: true, deletedAt: '2026-06-01T00:00:00.000Z' }));
    // mirrorTimestamp(deletedAt, null) leaves deleted_at NULL for an
    // unparseable value — `deleted_at < $1` is never true against NULL, so
    // the row is conservatively excluded from every cutoff.
    await db.writeRaw('ser-bad', S('ser-bad', { deleted: true, deletedAt: 'not-a-date' }));
    const cutoff = Date.parse('2026-03-01T00:00:00.000Z');
    expect(await db.listTombstoneIdsBefore(cutoff)).toEqual(['ser-old']);
  });

  it('tolerates a malformed timestamp without throwing (falls back)', async () => {
    await db.writeRaw('ser-bad', S('ser-bad', { updatedAt: 'not-a-date', createdAt: 'nope' }));
    const col = (await query(`SELECT created_at, updated_at FROM pipeline_series WHERE id = 'ser-bad'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date);
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('deleteRaw removes the row (idempotent)', async () => {
    await db.writeRaw('ser-1', S('ser-1'));
    await db.deleteRaw('ser-1');
    expect(await db.readRaw('ser-1')).toBeNull();
    await db.deleteRaw('ser-1');
  });
});
