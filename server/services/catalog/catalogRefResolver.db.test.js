/**
 * Catalog ref resolver (#1018).
 *
 * Two layers:
 *  1. A pure parity guard (no DB): REF_TARGET_TABLES must cover exactly the
 *     REF_KINDS the validation layer accepts — so a new referenceable record
 *     kind can't be added without a resolver target.
 *  2. A live-PG round-trip (SKIPS when no DB): insert refs + targets across all
 *     kinds, assert resolveRefs distinguishes live from
 *     deleted/absent targets. Synthetic rows use a `-rt-` id marker (and the
 *     fixed ING ingredient) so beforeEach/afterAll can DELETE exactly what the
 *     suite created without disturbing other rows.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { REF_TARGET_TABLES, RESOLVABLE_REF_KINDS } from './catalogRefResolver.js';
import { REF_KINDS } from '../../lib/catalog/catalogValidation.js';

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
const runDb = requireDbOrSkip('services/catalog/catalogRefResolver.db.test', dbReady, skipReason);

// The catalog refs table FKs ingredient_id → catalog_ingredients(id), so we
// need a real ingredient row (ING) to hang refs on. Synthetic target rows use a
// `-rt-` id marker so cleanup can DELETE exactly what this suite created. The
// target tables (id-keyed) are cleaned by id pattern; catalog_ingredient_refs
// (composite PK, no id column) is cleaned by ingredient_id.
const TARGET_TABLES = ['universes', 'pipeline_series', 'pipeline_issues', 'writers_room_works', 'creative_director_projects'];
const ING = 'cat-ing-resolvertest';

async function cleanSynthetic() {
  await query(`DELETE FROM catalog_ingredient_refs WHERE ingredient_id = $1`, [ING]).catch(() => {});
  for (const t of TARGET_TABLES) {
    await query(`DELETE FROM ${t} WHERE id LIKE '%-rt-%' OR id LIKE 'wr-work-rt%'`).catch(() => {});
  }
  await query(`DELETE FROM catalog_ingredients WHERE id = $1`, [ING]).catch(() => {});
}

describe.skipIf(!runDb)('catalog ref resolver — live resolution + dangling report', () => {
  let resolver;

  beforeAll(async () => { resolver = await import('./catalogRefResolver.js'); });

  beforeEach(async () => {
    await cleanSynthetic();
    await query(
      `INSERT INTO catalog_ingredients (id, type, name, payload) VALUES ($1, 'character', 'Resolver Test', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ING],
    );
  });

  afterAll(async () => {
    await cleanSynthetic();
    await close();
  });

  it('resolveRefs marks a tuple resolved only when a live target row exists', async () => {
    await query(`INSERT INTO universes (id, name, data) VALUES ('u-rt-1', 'U', '{}'::jsonb)`);
    // An issue requires a series_id (NOT NULL) — covers the pipeline_issues path.
    await query(`INSERT INTO pipeline_series (id, name, data) VALUES ('ser-rt-1', 'S', '{}'::jsonb)`);
    await query(`INSERT INTO pipeline_issues (id, series_id, data) VALUES ('iss-rt-1', 'ser-rt-1', '{}'::jsonb)`);
    const out = await resolver.resolveRefs([
      { refKind: 'universe', refId: 'u-rt-1' },      // live
      { refKind: 'issue', refId: 'iss-rt-1' },       // live (issue kind)
      { refKind: 'universe', refId: 'u-rt-absent' }, // never existed
      { refKind: 'frobnicate', refId: 'x' },         // unknown kind
      { refKind: 'series', refId: '' },              // missing id
    ]);
    expect(out[0]).toMatchObject({ resolved: true });
    expect(out[1]).toMatchObject({ resolved: true });
    // Unresolved-but-known carries the same `missing-target` reason as the report.
    expect(out[2]).toMatchObject({ resolved: false, reason: 'missing-target' });
    expect(out[3]).toMatchObject({ resolved: false, reason: 'unknown-kind' });
    expect(out[4]).toMatchObject({ resolved: false, reason: 'missing-ref-id' });
  });

  it('a soft-deleted target does NOT resolve', async () => {
    await query(`INSERT INTO writers_room_works (id, title, data, deleted) VALUES ('wr-work-rt1', 'W', '{}'::jsonb, TRUE)`);
    const [out] = await resolver.resolveRefs([{ refKind: 'work', refId: 'wr-work-rt1' }]);
    expect(out).toMatchObject({ resolved: false, reason: 'missing-target' });
  });

  it('a creative-director target resolves only while live (soft-delete kind, #1564)', async () => {
    await query(`INSERT INTO creative_director_projects (id, data) VALUES ('cd-rt-1', '{}'::jsonb)`);
    const [live] = await resolver.resolveRefs([{ refKind: 'creative-director', refId: 'cd-rt-1' }]);
    expect(live.resolved).toBe(true);
    // An absent row never resolves…
    const [gone] = await resolver.resolveRefs([{ refKind: 'creative-director', refId: 'cd-rt-gone' }]);
    expect(gone.resolved).toBe(false);
    // …and a SOFT-deleted CD project must not resolve either (the resolver's
    // liveClause was stale `null` before #1812, wrongly treating CD as live).
    await query(`UPDATE creative_director_projects SET deleted = TRUE, deleted_at = NOW() WHERE id = 'cd-rt-1'`);
    const [softGone] = await resolver.resolveRefs([{ refKind: 'creative-director', refId: 'cd-rt-1' }]);
    expect(softGone).toMatchObject({ resolved: false, reason: 'missing-target' });
  });
});
