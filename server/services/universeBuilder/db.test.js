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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'universes') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'universes table not present';
  }
}

const runDb = requireDbOrSkip('services/universeBuilder/db.test', dbReady, skipReason);

const U = (id, extra = {}) => ({
  id, name: id, schemaVersion: 4,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!runDb)('universeBuilder DB adapter round-trip', () => {
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


  it('projects names and index counts, with a compatibility fallback only for legacy canon', async () => {
    await db.writeRaw('u-live', U('u-live', {
      logline: 'A city', characters: [{ id: 'c1', name: 'Ada' }], places: [], objects: [],
      styleImageRefs: ['old.png', 'last.png'], premise: 'Not a summary field',
    }));
    await db.writeRaw('u-legacy', U('u-legacy', { schemaVersion: 3, categories: {} }));
    await db.writeRaw('u-deleted', U('u-deleted', { deleted: true }));
    const names = await db.listNames();
    expect(names.map((u) => u.id).sort()).toEqual(['u-legacy', 'u-live']);
    expect(names.find((u) => u.id === 'u-live')).toEqual({
      id: 'u-live', name: 'u-live', createdAt: '2026-01-01T00:00:00.000Z',
    });
    const summaries = await db.listSummaries();
    expect(summaries).toHaveLength(2);
    const live = summaries.find((u) => u.id === 'u-live');
    expect(live).toMatchObject({ canonCount: 1, styleImageRef: 'last.png', logline: 'A city', legacyRecord: null });
    expect(live).not.toHaveProperty('characters');
    expect(live).not.toHaveProperty('premise');
    expect(summaries.find((u) => u.id === 'u-legacy').legacyRecord.schemaVersion).toBe(3);
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

  it('listLiveIds returns only non-deleted ids', async () => {
    await db.writeRaw('live', U('live'));
    await db.writeRaw('dead', U('dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('ghost', U('ghost', { ephemeral: true }));
    expect((await db.listLiveIds()).sort()).toEqual(['ghost', 'live']);
  });

  it('listTombstoneIdsBefore returns only tombstones older than the cutoff, keeping a NULL deleted_at', async () => {
    await db.writeRaw('live', U('live'));
    await db.writeRaw('old', U('old', { deleted: true, deletedAt: '2026-01-01T00:00:00.000Z' }));
    await db.writeRaw('new', U('new', { deleted: true, deletedAt: '2026-06-01T00:00:00.000Z' }));
    // writeRaw's mirrorTimestamp(record.deletedAt, null) falls back to NULL
    // (not NOW()) for an unparseable deletedAt — `deleted_at < $1` is never
    // true against NULL, so this row is conservatively excluded from every
    // cutoff, matching the JS filter's "unparseable → kept" rule.
    await db.writeRaw('bad', U('bad', { deleted: true, deletedAt: 'not-a-date' }));
    const cutoff = Date.parse('2026-03-01T00:00:00.000Z');
    expect(await db.listTombstoneIdsBefore(cutoff)).toEqual(['old']);
  });

  it('listRaw returns every record body verbatim in one query', async () => {
    await db.writeRaw('u-1', U('u-1', { logline: 'x' }));
    await db.writeRaw('u-2', U('u-2'));
    const all = await db.listRaw();
    expect(all.map((r) => r.id).sort()).toEqual(['u-1', 'u-2']);
    expect(all.find((r) => r.id === 'u-1').logline).toBe('x');
  });

  it('listStyles projects the live set down to name + style fields', async () => {
    await db.writeRaw('live', U('live', {
      logline: 'a logline that must not ship',
      influences: { embrace: ['inky linework'], avoid: ['lowres'] },
    }));
    await db.writeRaw('dead', U('dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('legacy', U('legacy', { stylePrompt: 'ink wash', negativePrompt: 'blurry' }));

    const rows = await db.listStyles();
    expect(rows.map((r) => r.id).sort()).toEqual(['legacy', 'live']);

    const live = rows.find((r) => r.id === 'live');
    expect(live.name).toBe('live');
    expect(live.influences).toEqual({ embrace: ['inky linework'], avoid: ['lowres'] });
    // The projection is the whole point — nothing else comes back. Keys must
    // also match the file backend's row exactly (store.test.js pins that side).
    expect(Object.keys(live).sort())
      .toEqual(['createdAt', 'id', 'influences', 'name', 'negativePrompt', 'stylePrompt']);
    expect(live.logline).toBeUndefined();

    // Legacy v2 prose fields ride along so the service can fold them into tokens.
    const legacy = rows.find((r) => r.id === 'legacy');
    expect(legacy.stylePrompt).toBe('ink wash');
    expect(legacy.negativePrompt).toBe('blurry');
    expect(legacy.influences).toBeNull();
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
