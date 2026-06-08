/**
 * Postgres-backed round-trip for the Story Builder sessions DB adapter (#1016).
 * SKIPS cleanly when no DB is reachable. Snapshots + restores the table.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'story_builder_sessions') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'story_builder_sessions table not present';
  }
}

if (!dbReady) console.log(`⏭️  storyBuilderStore/db.test.js skipped: ${skipReason}`);

const S = (id, extra = {}) => ({
  id, title: id, intakeMode: 'seed', universeId: 'u-1', seriesId: 'ser-1',
  currentStep: 'idea', steps: {}, llm: { provider: null, model: null }, sync: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

describe.skipIf(!dbReady)('Story Builder sessions DB adapter round-trip', () => {
  let db;
  let snap = [];
  beforeAll(async () => {
    db = await import('./db.js');
    snap = (await query(`SELECT * FROM story_builder_sessions`)).rows;
  });

  beforeEach(async () => { await query(`DELETE FROM story_builder_sessions`); });

  afterAll(async () => {
    await query(`DELETE FROM story_builder_sessions`).catch(() => {});
    for (const r of snap) {
      await query(
        `INSERT INTO story_builder_sessions (id, universe_id, series_id, sync, data, ephemeral, created_at, updated_at, deleted, deleted_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.universe_id, r.series_id, r.sync, JSON.stringify(r.data), r.ephemeral, r.created_at, r.updated_at, r.deleted, r.deleted_at],
      ).catch(() => {});
    }
    await close();
  });

  it('writes a record and reads it back verbatim (steps + syncedHashes preserved)', async () => {
    const rec = S('stb-1', {
      sync: true,
      steps: { idea: { status: 'locked', locked: true, lockedAt: '2026-01-02T00:00:00.000Z', upstreamHash: 'h' } },
      syncedHashes: { idea: 'a'.repeat(64) },
    });
    await db.writeRaw('stb-1', rec);
    expect(await db.readRaw('stb-1')).toEqual(rec);
  });

  it('upsert updates the record and the mirror columns (universe/series/sync)', async () => {
    await db.writeRaw('stb-1', S('stb-1', { universeId: 'u-1', sync: false }));
    await db.writeRaw('stb-1', S('stb-1', { universeId: 'u-2', seriesId: 'ser-2', sync: true, updatedAt: '2026-03-03T00:00:00.000Z' }));
    const col = (await query(`SELECT universe_id, series_id, sync, updated_at FROM story_builder_sessions WHERE id = 'stb-1'`)).rows[0];
    expect(col.universe_id).toBe('u-2');
    expect(col.series_id).toBe('ser-2');
    expect(col.sync).toBe(true);
    expect(new Date(col.updated_at).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('the OPT-IN sync filter serves only sync-enabled sessions', async () => {
    await db.writeRaw('stb-on', S('stb-on', { sync: true }));
    await db.writeRaw('stb-off', S('stb-off', { sync: false }));
    const synced = (await query(`SELECT id FROM story_builder_sessions WHERE sync = TRUE ORDER BY id`)).rows;
    expect(synced.map((r) => r.id)).toEqual(['stb-on']);
  });

  it('listIds returns live, tombstoned, and ephemeral ids alike', async () => {
    await db.writeRaw('stb-live', S('stb-live'));
    await db.writeRaw('stb-dead', S('stb-dead', { deleted: true, deletedAt: '2026-02-02T00:00:00.000Z' }));
    await db.writeRaw('stb-ghost', S('stb-ghost', { ephemeral: true }));
    expect((await db.listIds()).sort()).toEqual(['stb-dead', 'stb-ghost', 'stb-live']);
  });

  it('tolerates a malformed timestamp without throwing', async () => {
    await db.writeRaw('stb-bad', S('stb-bad', { updatedAt: 'not-a-date', createdAt: 'nope' }));
    const col = (await query(`SELECT created_at, updated_at FROM story_builder_sessions WHERE id = 'stb-bad'`)).rows[0];
    expect(col.created_at).toBeInstanceOf(Date);
    expect(col.updated_at).toBeInstanceOf(Date);
  });

  it('deleteRaw removes the row (idempotent)', async () => {
    await db.writeRaw('stb-1', S('stb-1'));
    await db.deleteRaw('stb-1');
    expect(await db.readRaw('stb-1')).toBeNull();
    await db.deleteRaw('stb-1');
  });
});
