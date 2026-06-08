/**
 * Catalog ref resolver + dangling-ref integrity (#1018).
 *
 * Two layers:
 *  1. A pure parity guard (no DB): REF_TARGET_TABLES must cover exactly the
 *     REF_KINDS the validation layer accepts — so a new referenceable record
 *     kind can't be added without a resolver target.
 *  2. A live-PG round-trip (SKIPS when no DB): insert refs + targets across all
 *     kinds, assert resolveRefs / listDanglingRefs distinguish live from
 *     deleted/absent targets. Snapshots + restores every touched table.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { REF_TARGET_TABLES, RESOLVABLE_REF_KINDS } from './catalogRefResolver.js';
import { REF_KINDS } from '../lib/catalogValidation.js';

describe('catalog ref resolver — target-table parity (no DB)', () => {
  it('REF_TARGET_TABLES covers exactly the validated REF_KINDS', () => {
    expect([...RESOLVABLE_REF_KINDS].sort()).toEqual([...REF_KINDS].sort());
  });

  it('every target maps to a non-empty table name', () => {
    for (const kind of RESOLVABLE_REF_KINDS) {
      expect(REF_TARGET_TABLES[kind].table).toMatch(/^[a-z_]+$/);
    }
  });
});

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'catalog_ingredient_refs') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'catalog_ingredient_refs table not present';
  }
}
if (!dbReady) console.log(`⏭️  catalogRefResolver.test.js (live) skipped: ${skipReason}`);

// The catalog refs table FKs ingredient_id → catalog_ingredients(id), so we need
// a real ingredient row to hang refs on. We snapshot/restore the touched tables.
const TOUCHED = [
  'catalog_ingredient_refs', 'catalog_ingredients',
  'universes', 'pipeline_series', 'pipeline_issues', 'writers_room_works', 'creative_director_projects',
];

describe.skipIf(!dbReady)('catalog ref resolver — live resolution + dangling report', () => {
  let resolver;
  const snaps = {};
  const ING = 'cat-ing-resolvertest';

  beforeAll(async () => {
    resolver = await import('./catalogRefResolver.js');
    for (const t of TOUCHED) snaps[t] = (await query(`SELECT * FROM ${t}`)).rows;
  });

  beforeEach(async () => {
    await query(`DELETE FROM catalog_ingredient_refs WHERE ingredient_id = $1`, [ING]);
    await query(`DELETE FROM catalog_ingredients WHERE id = $1`, [ING]);
    // Clean the synthetic targets we create below.
    await query(`DELETE FROM universes WHERE id LIKE 'u-rt-%'`);
    await query(`DELETE FROM pipeline_series WHERE id LIKE 'ser-rt-%'`);
    await query(`DELETE FROM pipeline_issues WHERE id LIKE 'iss-rt-%'`);
    await query(`DELETE FROM writers_room_works WHERE id LIKE 'wr-work-rt%'`);
    await query(`DELETE FROM creative_director_projects WHERE id LIKE 'cd-rt-%'`);
    await query(
      `INSERT INTO catalog_ingredients (id, type, name, payload) VALUES ($1, 'character', 'Resolver Test', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ING],
    );
  });

  afterAll(async () => {
    for (const t of TOUCHED) {
      await query(`DELETE FROM ${t} WHERE id LIKE '%-rt-%' OR id LIKE 'wr-work-rt%'`).catch(() => {});
    }
    await query(`DELETE FROM catalog_ingredient_refs WHERE ingredient_id = $1`, [ING]).catch(() => {});
    await query(`DELETE FROM catalog_ingredients WHERE id = $1`, [ING]).catch(() => {});
    await close();
  });

  const linkRef = (refKind, refId, role = 'mentioned') => query(
    `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [ING, refKind, refId, role],
  );

  it('resolveRefs marks a tuple resolved only when a live target row exists', async () => {
    await query(`INSERT INTO universes (id, name, data) VALUES ('u-rt-1', 'U', '{}'::jsonb)`);
    const out = await resolver.resolveRefs([
      { refKind: 'universe', refId: 'u-rt-1' },     // live
      { refKind: 'universe', refId: 'u-rt-absent' }, // never existed
      { refKind: 'frobnicate', refId: 'x' },         // unknown kind
      { refKind: 'series', refId: '' },              // missing id
    ]);
    expect(out[0]).toMatchObject({ resolved: true });
    expect(out[1].resolved).toBe(false); // absent target — no reason key, just unresolved
    expect(out[2]).toMatchObject({ resolved: false, reason: 'unknown-kind' });
    expect(out[3]).toMatchObject({ resolved: false, reason: 'missing-ref-id' });
  });

  it('a soft-deleted target does NOT resolve', async () => {
    await query(`INSERT INTO writers_room_works (id, title, data, deleted) VALUES ('wr-work-rt1', 'W', '{}'::jsonb, TRUE)`);
    const [out] = await resolver.resolveRefs([{ refKind: 'work', refId: 'wr-work-rt1' }]);
    expect(out.resolved).toBe(false);
  });

  it('a creative-director target resolves by row existence (hard-delete kind)', async () => {
    await query(`INSERT INTO creative_director_projects (id, data) VALUES ('cd-rt-1', '{}'::jsonb)`);
    const [live] = await resolver.resolveRefs([{ refKind: 'creative-director', refId: 'cd-rt-1' }]);
    expect(live.resolved).toBe(true);
    const [gone] = await resolver.resolveRefs([{ refKind: 'creative-director', refId: 'cd-rt-gone' }]);
    expect(gone.resolved).toBe(false);
  });

  it('listDanglingRefs reports only refs whose live target is missing', async () => {
    // One live target (universe), one missing (series), one soft-deleted (work).
    await query(`INSERT INTO universes (id, name, data) VALUES ('u-rt-1', 'U', '{}'::jsonb)`);
    await query(`INSERT INTO writers_room_works (id, title, data, deleted) VALUES ('wr-work-rt2', 'W', '{}'::jsonb, TRUE)`);
    await linkRef('universe', 'u-rt-1');
    await linkRef('series', 'ser-rt-missing');
    await linkRef('work', 'wr-work-rt2');

    const dangling = await resolver.listDanglingRefs();
    const keys = dangling.map((d) => `${d.refKind}:${d.refId}`);
    expect(keys).toContain('series:ser-rt-missing');
    expect(keys).toContain('work:wr-work-rt2');
    expect(keys).not.toContain('universe:u-rt-1'); // live → not dangling
    const series = dangling.find((d) => d.refId === 'ser-rt-missing');
    expect(series).toMatchObject({ reason: 'missing-target', linkCount: 1 });
  });

  it('a tombstoned (unlinked) ref is excluded from the dangling report', async () => {
    await linkRef('series', 'ser-rt-missing');
    await query(
      `UPDATE catalog_ingredient_refs SET deleted = TRUE, deleted_at = NOW()
        WHERE ingredient_id = $1 AND ref_id = 'ser-rt-missing'`,
      [ING],
    );
    const dangling = await resolver.listDanglingRefs();
    expect(dangling.some((d) => d.refId === 'ser-rt-missing')).toBe(false);
  });
});
