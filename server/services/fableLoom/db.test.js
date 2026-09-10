/**
 * Postgres-backed round-trip for the FableLoom DB adapter.
 *
 * Like universeBuilder/db.test.js and pipeline/seriesStore/db.test.js, needs a
 * live PostgreSQL with the schema applied; SKIPS cleanly when no DB is
 * reachable. Snapshots + restores the table so a developer's real looms
 * survive the run. This file didn't exist before #6851 — fableLoom/db.js had
 * no direct PG-adapter coverage (only exercised indirectly through the file
 * backend in records.test.js), so it covers the pre-existing leaf I/O
 * alongside the new id projections added for the tombstone-sweep hydration fix.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'fableloom_stories') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'fableloom_stories table not present';
  }
}

const runDb = requireDbOrSkip('services/fableLoom/db.test', dbReady, skipReason);

const L = (id, extra = {}) => ({
  id, name: id, universeId: null, seriesId: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!runDb)('fableLoom DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM fableloom_stories`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM fableloom_stories`); });

  afterAll(async () => {
    await query(`DELETE FROM fableloom_stories`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO fableloom_stories (id, name, universe_id, series_id, data, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.name, r.universe_id, r.series_id, JSON.stringify(r.data), r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('writes a record and reads it back verbatim', async () => {
    const rec = L('loom-1', { universeId: 'u-1', episodes: [{ id: 'ep-1', nodes: [] }] });
    await db.writeRaw('loom-1', rec);
    expect(await db.readRaw('loom-1')).toEqual(rec);
  });

  it('upsert updates the record and the mirror columns', async () => {
    await db.writeRaw('loom-1', L('loom-1', { name: 'First', universeId: 'u-1' }));
    await db.writeRaw('loom-1', L('loom-1', { name: 'Renamed', universeId: 'u-2', updatedAt: '2026-03-03T00:00:00.000Z' }));
    const col = (await query(`SELECT name, universe_id, updated_at FROM fableloom_stories WHERE id = 'loom-1'`)).rows[0];
    expect(col.name).toBe('Renamed');
    expect(col.universe_id).toBe('u-2');
    expect(new Date(col.updated_at).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('listRaw returns every record body verbatim, newest-updated first', async () => {
    await db.writeRaw('loom-a', L('loom-a', { updatedAt: '2026-01-01T00:00:00.000Z' }));
    await db.writeRaw('loom-b', L('loom-b', { updatedAt: '2026-02-01T00:00:00.000Z' }));
    const all = await db.listRaw();
    expect(all.map((r) => r.id)).toEqual(['loom-b', 'loom-a']);
  });

  it('listIds returns live and tombstoned ids alike', async () => {
    await db.writeRaw('loom-live', L('loom-live'));
    await db.writeRaw('loom-dead', L('loom-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    expect((await db.listIds()).sort()).toEqual(['loom-dead', 'loom-live']);
  });

  it('listLiveIds returns only non-deleted ids', async () => {
    await db.writeRaw('loom-live', L('loom-live'));
    await db.writeRaw('loom-dead', L('loom-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    expect(await db.listLiveIds()).toEqual(['loom-live']);
  });

  it('listTombstoneIdsBefore returns only tombstones older than the cutoff, keeping a NULL deleted_at', async () => {
    await db.writeRaw('loom-live', L('loom-live'));
    await db.writeRaw('loom-old', L('loom-old', { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' }));
    await db.writeRaw('loom-new', L('loom-new', { deleted: true, deletedAt: '2026-06-01T00:00:00.000Z' }));
    // mirrorTimestamp(deletedAt, null) leaves deleted_at NULL for an
    // unparseable value — `deleted_at < $1` is never true against NULL, so
    // the row is conservatively excluded from every cutoff.
    await db.writeRaw('loom-bad', L('loom-bad', { deleted: true, deletedAt: 'not-a-date' }));
    const cutoff = Date.parse('2026-03-01T00:00:00.000Z');
    expect(await db.listTombstoneIdsBefore(cutoff)).toEqual(['loom-old']);
  });

  it('tolerates a malformed timestamp without throwing (falls back)', async () => {
    await db.writeRaw('loom-bad', L('loom-bad', { updatedAt: 'not-a-date', createdAt: 'nope' }));
    const back = await db.readRaw('loom-bad');
    expect(back.id).toBe('loom-bad'); // data stored verbatim
    const col = (await query(`SELECT created_at, updated_at FROM fableloom_stories WHERE id = 'loom-bad'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date); // fell back to NOW(), not null/throw
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('deleteRaw removes the row (idempotent)', async () => {
    await db.writeRaw('loom-1', L('loom-1'));
    await db.deleteRaw('loom-1');
    expect(await db.readRaw('loom-1')).toBeNull();
    await db.deleteRaw('loom-1'); // no throw on missing
  });
});
