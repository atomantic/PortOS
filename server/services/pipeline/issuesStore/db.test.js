/**
 * Postgres-backed round-trip for the pipeline issues DB adapter (#1015).
 * SKIPS cleanly when no DB is reachable. Snapshots + restores the table.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../../lib/db.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'pipeline_issues') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'pipeline_issues table not present';
  }
}

if (!dbReady) console.log(`⏭️  pipeline/issuesStore/db.test.js skipped: ${skipReason}`);

const I = (id, extra = {}) => ({
  id, seriesId: 'ser-1', seasonId: null, number: 1, status: 'draft', title: id,
  stages: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!dbReady)('pipeline issues DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM pipeline_issues`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM pipeline_issues`); });

  afterAll(async () => {
    await query(`DELETE FROM pipeline_issues`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO pipeline_issues (id, series_id, season_id, number, status, data, ephemeral, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.series_id, r.season_id, r.number, r.status, JSON.stringify(r.data), r.ephemeral, r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('writes a record and reads it back verbatim (full stages map preserved)', async () => {
    const rec = I('iss-1', { stages: { idea: { status: 'ready', output: 'beats', lastRunId: 'run-7' } } });
    await db.writeRaw('iss-1', rec);
    expect(await db.readRaw('iss-1')).toEqual(rec);
  });

  it('upsert updates the record and the mirror columns (series_id/number/status)', async () => {
    await db.writeRaw('iss-1', I('iss-1', { number: 1, status: 'draft' }));
    await db.writeRaw('iss-1', I('iss-1', { number: 3, status: 'shipped', updatedAt: '2026-03-03T00:00:00.000Z' }));
    const col = (await query(`SELECT series_id, number, status, updated_at FROM pipeline_issues WHERE id = 'iss-1'`)).rows[0];
    expect(col.number).toBe(3);
    expect(col.status).toBe('shipped');
    expect(new Date(col.updated_at).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('idx_issues_series serves the renumber query (series ordered by number)', async () => {
    await db.writeRaw('iss-b', I('iss-b', { number: 2 }));
    await db.writeRaw('iss-a', I('iss-a', { number: 1 }));
    await db.writeRaw('iss-d', I('iss-d', { number: 9, deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    const ordered = (await query(
      `SELECT id FROM pipeline_issues WHERE series_id = 'ser-1' AND deleted = FALSE ORDER BY number`,
    )).rows;
    expect(ordered.map((r) => r.id)).toEqual(['iss-a', 'iss-b']);
  });

  it('listIds returns live, tombstoned, and ephemeral ids alike', async () => {
    await db.writeRaw('iss-live', I('iss-live'));
    await db.writeRaw('iss-dead', I('iss-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('iss-ghost', I('iss-ghost', { ephemeral: true }));
    expect((await db.listIds()).sort()).toEqual(['iss-dead', 'iss-ghost', 'iss-live']);
  });

  it('listIds({ includeDeleted: false }) excludes tombstones via the mirror column (#2540)', async () => {
    await db.writeRaw('iss-live', I('iss-live'));
    await db.writeRaw('iss-ghost', I('iss-ghost', { ephemeral: true }));
    await db.writeRaw('iss-dead', I('iss-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    // Ephemeral rows are live (deleted = false) so they stay in the sweep.
    expect((await db.listIds({ includeDeleted: false })).sort()).toEqual(['iss-ghost', 'iss-live']);
  });

  it('tolerates a malformed timestamp without throwing', async () => {
    await db.writeRaw('iss-bad', I('iss-bad', { updatedAt: 'not-a-date', createdAt: 'nope' }));
    const col = (await query(`SELECT created_at, updated_at FROM pipeline_issues WHERE id = 'iss-bad'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date);
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('deleteRaw removes the row (idempotent)', async () => {
    await db.writeRaw('iss-1', I('iss-1'));
    await db.deleteRaw('iss-1');
    expect(await db.readRaw('iss-1')).toBeNull();
    await db.deleteRaw('iss-1');
  });
});
