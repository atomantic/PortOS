/**
 * Postgres-backed round-trip for the catalog user-type store (#1001).
 *
 * Like projectsDB.test.js / mediaAssetIndex/db.test.js, this needs a live
 * PostgreSQL with the schema applied. If no DB is reachable (CI, fresh
 * checkout) it SKIPS cleanly rather than failing red. When a DB IS reachable it
 * exercises the whole-slice writeUserTypes contract: upsert-everything +
 * prune-departed, tombstone retention, and verbatim readback. It snapshots and
 * restores the table so a developer's real user types survive the run.
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'catalog_user_types') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'catalog_user_types table not present';
  }
}

if (!dbReady) console.log(`⏭️  catalogUserTypes/db.test.js skipped: ${skipReason}`);

const T = (id, extra = {}) => ({ id, label: id, primaryContentKey: 'description', fields: [], ...extra });

describe.skipIf(!dbReady)('catalog user-type DB round-trip', () => {
  let db;
  let snapshot = [];
  beforeAll(async () => {
    db = await import('./db.js');
    const res = await query(`SELECT id, data, updated_at, deleted_at, created_at FROM catalog_user_types`);
    snapshot = res.rows;
  });

  beforeEach(async () => {
    await query(`DELETE FROM catalog_user_types`);
  });

  afterAll(async () => {
    await query(`DELETE FROM catalog_user_types`).catch(() => {});
    for (const r of snapshot) {
      await query(
        `INSERT INTO catalog_user_types (id, data, updated_at, deleted_at, created_at)
         VALUES ($1, $2::jsonb, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [r.id, JSON.stringify(r.data), r.updated_at, r.deleted_at, r.created_at],
      ).catch(() => {});
    }
    await close();
  });

  it('writes the whole slice and reads it back verbatim', async () => {
    const slice = [T('faction', { updatedAt: '2026-01-01T00:00:00.000Z' }), T('guild')];
    await db.writeUserTypes(slice);
    const back = await db.readUserTypes();
    expect(back.map((t) => t.id).sort()).toEqual(['faction', 'guild']);
    expect(back.find((t) => t.id === 'faction')).toMatchObject({ label: 'faction', updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('prunes a row whose id left the slice (whole-slice is authoritative)', async () => {
    await db.writeUserTypes([T('a'), T('b'), T('c')]);
    await db.writeUserTypes([T('a'), T('c')]); // b departed
    const ids = (await db.readUserTypes()).map((t) => t.id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('clears the table when given an empty slice (or null)', async () => {
    await db.writeUserTypes([T('a')]);
    await db.writeUserTypes([]);
    expect(await db.readUserTypes()).toHaveLength(0);
    await db.writeUserTypes([T('a')]);
    await db.writeUserTypes(null);
    expect(await db.readUserTypes()).toHaveLength(0);
  });

  it('retains a tombstone row (deletedAt set) so the deletion can keep federating', async () => {
    await db.writeUserTypes([T('faction', { deletedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' })]);
    const back = await db.readUserTypes();
    expect(back).toHaveLength(1);
    expect(back[0].deletedAt).toBe('2026-06-01T00:00:00.000Z');
    // The tombstone column mirrors the data tombstone for queryability.
    const { rows } = await query(`SELECT deleted_at FROM catalog_user_types WHERE id = 'faction'`);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('tolerates a malformed updatedAt without throwing (bind-safe mirror columns)', async () => {
    await expect(db.writeUserTypes([T('faction', { updatedAt: 'not-a-date' })])).resolves.not.toThrow();
    const { rows } = await query(`SELECT updated_at FROM catalog_user_types WHERE id = 'faction'`);
    expect(rows[0].updated_at).not.toBeNull(); // fell back to NOW()
  });

  it('skips an entry with no usable id', async () => {
    await db.writeUserTypes([T('ok'), { label: 'no id' }, { id: '' }, null]);
    expect((await db.readUserTypes()).map((t) => t.id)).toEqual(['ok']);
  });
});
