/**
 * Postgres-backed round-trip for the Universe Builder DB adapter (#1014).
 *
 * Like catalogUserTypes/db.test.js, this needs a live PostgreSQL with the schema
 * applied. If no DB is reachable (CI, fresh checkout) it SKIPS cleanly rather
 * than failing red. When a DB IS reachable it exercises the leaf I/O: verbatim
 * record readback, listIds across live/tombstone/ephemeral, malformed-timestamp
 * tolerance, the runs cap + cascade-remove, and hard delete. It snapshots and
 * restores both tables so a developer's real universes survive the run.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'universes') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'universes table not present';
  }
}

if (!dbReady) console.log(`⏭️  universeBuilder/db.test.js skipped: ${skipReason}`);

const U = (id, extra = {}) => ({
  id, name: id, schemaVersion: 4,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!dbReady)('universeBuilder DB adapter round-trip', () => {
  let db;
  let uSnap = [];
  let rSnap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    uSnap = (await query(`SELECT * FROM universes`)).rows;
    rSnap = (await query(`SELECT * FROM universe_runs`)).rows;
  });

  beforeEach(async () => {
    await query(`DELETE FROM universe_runs`);
    await query(`DELETE FROM universes`);
  });

  afterAll(async () => {
    await query(`DELETE FROM universe_runs`).catch(() => {});
    await query(`DELETE FROM universes`).catch(() => {});
    for (const r of uSnap) {
      await query(
        `INSERT INTO universes (id, name, data, schema_version, ephemeral, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.name, JSON.stringify(r.data), r.schema_version, r.ephemeral, r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    for (const r of rSnap) {
      await query(
        `INSERT INTO universe_runs (id, universe_id, collection_id, data, created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.universe_id, r.collection_id, JSON.stringify(r.data), r.created_at],
      ).catch(() => {});
    }
    await close();
  });

  it('writes a record and reads it back verbatim', async () => {
    const rec = U('u-1', { logline: 'a city', characters: [{ id: 'c1', name: 'Ada' }] });
    await db.writeRaw('u-1', rec);
    const back = await db.readRaw('u-1');
    expect(back).toEqual(rec);
  });

  it('upsert updates the record and the mirror columns', async () => {
    await db.writeRaw('u-1', U('u-1', { name: 'First' }));
    await db.writeRaw('u-1', U('u-1', { name: 'Renamed', updatedAt: '2026-03-03T00:00:00.000Z' }));
    const back = await db.readRaw('u-1');
    expect(back.name).toBe('Renamed');
    const col = (await query(`SELECT name, updated_at FROM universes WHERE id = 'u-1'`)).rows[0];
    expect(col.name).toBe('Renamed');
    expect(new Date(col.updated_at).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('listIds returns live, tombstoned, and ephemeral ids alike', async () => {
    await db.writeRaw('live', U('live'));
    await db.writeRaw('dead', U('dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ghost', U('ghost', { ephemeral: true }));
    const ids = (await db.listIds()).sort();
    expect(ids).toEqual(['dead', 'ghost', 'live']);
  });

  it('listRaw returns every record body verbatim in one query', async () => {
    await db.writeRaw('u-1', U('u-1', { logline: 'x' }));
    await db.writeRaw('u-2', U('u-2'));
    const all = await db.listRaw();
    expect(all.map((r) => r.id).sort()).toEqual(['u-1', 'u-2']);
    expect(all.find((r) => r.id === 'u-1').logline).toBe('x');
  });

  it('countUniverses counts the live set without materializing it', async () => {
    // The cheap tally the character skill registry reads (#2729). It counts the
    // `deleted` MIRROR COLUMN, while the service filters listUniverses() on the
    // JSONB flag — so this pins that the two can't drift: writeRaw derives both
    // from the same record.deleted in one statement.
    expect(await db.countUniverses()).toBe(0);

    await db.writeRaw('live', U('live'));
    await db.writeRaw('dead', U('dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ghost', U('ghost', { ephemeral: true }));

    // listIds() sees all three; the tombstone must NOT be counted (the exact bug a
    // naive listIds().length would introduce). Ephemeral universes DO count —
    // listUniverses filters only on `deleted`, so filtering them here would undercount.
    expect((await db.listIds())).toHaveLength(3);
    expect(await db.countUniverses()).toBe(2);
    // Agrees with the same filter the service applies to the JSONB flag on read.
    expect(await db.countUniverses())
      .toBe((await db.listRaw()).filter((r) => r?.deleted !== true).length);

    expect(await db.countUniverses({ includeDeleted: true })).toBe(3);
    expect(await db.countUniverses({ includeDeleted: true })).toBe((await db.listRaw()).length);

    // Un-deleting through the normal write path rewrites both the column and the
    // JSONB flag, so the count follows.
    await db.writeRaw('dead', U('dead'));
    expect(await db.countUniverses()).toBe(3);
  });

  it('tolerates a malformed timestamp without throwing (falls back)', async () => {
    await db.writeRaw('u-bad', U('u-bad', { updatedAt: 'not-a-date', createdAt: 'nope' }));
    const back = await db.readRaw('u-bad');
    expect(back.id).toBe('u-bad'); // data stored verbatim
    const col = (await query(`SELECT created_at, updated_at FROM universes WHERE id = 'u-bad'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date); // fell back to NOW(), not null/throw
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('deleteRaw removes the row (idempotent)', async () => {
    await db.writeRaw('u-1', U('u-1'));
    await db.deleteRaw('u-1');
    expect(await db.readRaw('u-1')).toBeNull();
    await db.deleteRaw('u-1'); // no throw on missing
  });

  it('appendRun stores runs and caps the global log at 200', async () => {
    for (let i = 0; i < 205; i += 1) {
      await db.appendRun({ id: `run-${String(i).padStart(3, '0')}`, universeId: 'u-1', jobIds: [], promptCount: i, createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` });
    }
    const count = (await query(`SELECT COUNT(*)::int AS n FROM universe_runs`)).rows[0].n;
    expect(count).toBe(200);
  });

  it('removeRunsForUniverses drops only the named universes runs', async () => {
    await db.appendRun({ id: 'r-a', universeId: 'u-A', jobIds: [], promptCount: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.appendRun({ id: 'r-b', universeId: 'u-B', jobIds: [], promptCount: 1, createdAt: '2026-01-01T00:00:01.000Z' });
    await db.removeRunsForUniverses(['u-A']);
    const remaining = await db.loadRuns();
    expect(remaining.map((r) => r.universeId)).toEqual(['u-B']);
  });
});
