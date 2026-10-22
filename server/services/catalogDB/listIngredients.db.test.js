/**
 * listIngredients reads the identity read views (catalog_identity_read_refs /
 * _media / _sources) once per statement, not once per ingredient row (#12989).
 *
 * The equivalence suite pins the rewritten album filters and card decorations
 * to the correlated-subquery statement they replaced (LEGACY_* below, frozen
 * from the pre-#12989 implementation) on a fixture that exercises every view
 * branch: live rows, a local merge (catalog_ingredient_merges) and a committed
 * shared-identity operation whose plan and snapshot rows feed the views.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`. The
 * DB is shared, so every comparison is scoped to this run's nonce tag.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: vi.fn(actual.query) };
});
vi.mock('../instanceIdentity.js', () => ({ getInstanceId: async () => 'list-test-local', UNKNOWN_INSTANCE_ID: 'unknown' }));

const { checkHealth, close, ensureSchema, query } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { listIngredients } = await import('./ingredients.js');
const { HOMING_REF_KINDS_SQL, liveHomingTargetSql } = await import('./shared.js');

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/catalogDB/listIngredients.db.test', health.connected, health.error);
if (ready) await ensureSchema();

const P = `list-${randomUUID()}`;
const TAG = `${P}-tag`;
const UNI = `${P}-uni`;
const SER = `${P}-ser`;
const DEAD_UNI = `${P}-dead-uni`;
const CD_DEAD = `${P}-cd`;
const SCRAP = `${P}-scrap`;
const OP = `${P}-op`;
const MERGE = `${P}-merge`;
const id = (name) => `${P}-${name}`;
const now = '2026-01-02T00:00:00.000Z';

// Frozen pre-#12989 statement: correlated subqueries over the read views.
const LEGACY_HAS_LIVE = `EXISTS (SELECT 1 FROM catalog_identity_read_refs r
  WHERE catalog_canonical_ingredient_id(r.ingredient_id) = catalog_ingredients.id AND r.deleted = false AND ${liveHomingTargetSql('r')})`;
const LEGACY_HAS_ANY = `EXISTS (SELECT 1 FROM catalog_identity_read_refs r
  WHERE catalog_canonical_ingredient_id(r.ingredient_id) = catalog_ingredients.id AND r.deleted = false AND r.ref_kind IN (${HOMING_REF_KINDS_SQL}))`;
const LEGACY_THUMBNAIL = `(SELECT m.media_key FROM catalog_identity_read_media m
  WHERE catalog_canonical_ingredient_id(m.ingredient_id) = catalog_ingredients.id AND m.deleted = false
    AND m.kind IN ('portrait', 'reference')
    AND (m.role IS NULL OR NOT (m.role LIKE 'sheet:%' OR m.role LIKE 'look:%' OR m.role LIKE 'archive:%' OR m.role = 'plate'))
  ORDER BY (m.kind = 'portrait') DESC, m.created_at DESC LIMIT 1) AS thumbnail_key`;
const LEGACY_USAGE = `(SELECT jsonb_object_agg(u.ref_kind, u.n) FROM (
  SELECT r.ref_kind, COUNT(DISTINCT r.ref_id) AS n FROM catalog_identity_read_refs r
  WHERE catalog_canonical_ingredient_id(r.ingredient_id) = catalog_ingredients.id AND r.deleted = false
    AND (r.ref_kind NOT IN (${HOMING_REF_KINDS_SQL}) OR ${liveHomingTargetSql('r')})
  GROUP BY r.ref_kind) u) AS ref_usage`;

async function legacyList({ refKind, refId, unlinked, orphaned, scrapId }) {
  const conditions = ['deleted = false', 'id = catalog_canonical_ingredient_id(id)', '$1 = ANY(tags)'];
  const params = [TAG];
  if (refKind === 'universe') {
    params.push(refId);
    conditions.push(`EXISTS (SELECT 1 FROM catalog_identity_read_refs r
      WHERE catalog_canonical_ingredient_id(r.ingredient_id) = catalog_ingredients.id AND r.deleted = false
        AND ((r.ref_kind = 'universe' AND r.ref_id = $2)
          OR (r.ref_kind = 'series' AND r.ref_id IN (SELECT id FROM pipeline_series WHERE universe_id = $2 AND deleted = false))))`);
  } else if (refKind) {
    params.push(refKind, refId);
    conditions.push(`EXISTS (SELECT 1 FROM catalog_identity_read_refs r
      WHERE catalog_canonical_ingredient_id(r.ingredient_id) = catalog_ingredients.id AND r.deleted = false
        AND r.ref_kind = $2 AND r.ref_id = $3)`);
  } else if (unlinked) {
    conditions.push(`NOT ${LEGACY_HAS_ANY}`);
  } else if (orphaned) {
    conditions.push(LEGACY_HAS_ANY, `NOT ${LEGACY_HAS_LIVE}`);
  }
  if (scrapId) {
    params.push(scrapId);
    conditions.push(`EXISTS (SELECT 1 FROM catalog_identity_read_sources cis
      WHERE catalog_canonical_ingredient_id(cis.ingredient_id) = catalog_ingredients.id AND cis.scrap_id = $${params.length})`);
  }
  const { rows } = await query(
    `SELECT id, ${LEGACY_THUMBNAIL}, ${LEGACY_USAGE} FROM catalog_ingredients
      WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params,
  );
  return rows.map((row) => ({ id: row.id, thumbnailKey: row.thumbnail_key ?? null, usage: row.ref_usage ?? {} }));
}

async function insertIngredient(name, secondsAgo, owner = 'list-test-local') {
  await query(
    `INSERT INTO catalog_ingredients (id, type, name, payload, tags, origin_instance_id, created_at)
     VALUES ($1, 'character', $2, '{}'::jsonb, ARRAY[$3], $4, NOW() - make_interval(secs => $5))`,
    [id(name), `Example ${name}`, TAG, owner, secondsAgo],
  );
}
const insertRef = (name, refKind, refId, { role = 'cast', deleted = false } = {}) => query(
  `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, deleted) VALUES ($1, $2, $3, $4, $5)`,
  [id(name), refKind, refId, role, deleted],
);
const insertMedia = (name, key, kind, { role = null, secondsAgo = 0 } = {}) => query(
  `INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, created_at)
   VALUES ($1, $2, $3, $4, NOW() - make_interval(secs => $5))`,
  [id(name), `${P}-${key}`, kind, role, secondsAgo],
);
const refRow = (name, refKind, refId) => ({ ingredient_id: id(name), ref_kind: refKind, ref_id: refId, role: 'cast', created_at: now, updated_at: now, deleted: false });
const mediaRow = (name, key, kind) => ({ ingredient_id: id(name), media_key: `${P}-${key}`, kind, role: null, caption: null, metadata: {}, library: {}, created_at: now, updated_at: now, deleted: false });

beforeAll(async () => {
  if (!ready) return;
  await query('INSERT INTO universes (id, name) VALUES ($1, $2)', [UNI, 'Example Universe']);
  await query('INSERT INTO pipeline_series (id, name, universe_id) VALUES ($1, $2, $3)', [SER, 'Example Series', UNI]);
  await query("INSERT INTO creative_director_projects (id, data, deleted, deleted_at) VALUES ($1, '{}'::jsonb, TRUE, NOW())", [CD_DEAD]);
  await query("INSERT INTO catalog_scraps (id, title, raw_text, source_kind) VALUES ($1, 'Example scrap', 'Example text', 'paste')", [SCRAP]);

  const names = ['raw', 'linked', 'series-only', 'orphan', 'mixed', 'dead-ref-gone', 'thumbs', 'merge-source', 'merge-survivor', 'op-source', 'op-survivor'];
  for (const [i, name] of names.entries()) {
    const owner = name === 'op-survivor' ? 'list-test-peer' : 'list-test-local';
    await insertIngredient(name, (names.length - i) * 10, owner);
  }
  await insertRef('linked', 'universe', UNI);
  await insertRef('linked', 'universe', UNI, { role: 'mentioned' });
  await insertRef('linked', 'issue', `${P}-issue`);
  await insertRef('series-only', 'series', SER);
  await insertRef('orphan', 'universe', DEAD_UNI);
  await insertRef('orphan', 'creative-director', CD_DEAD);
  await insertRef('mixed', 'universe', DEAD_UNI);
  await insertRef('mixed', 'series', SER);
  await insertRef('dead-ref-gone', 'universe', UNI, { deleted: true });
  await insertMedia('thumbs', 'portrait', 'portrait', { secondsAgo: 30 });
  await insertMedia('thumbs', 'newer-ref', 'reference', { secondsAgo: 5 });
  await insertMedia('linked', 'old-ref', 'reference', { secondsAgo: 20 });
  await insertMedia('linked', 'new-ref', 'reference', { secondsAgo: 10 });
  await insertMedia('linked', 'sheet', 'reference', { role: 'sheet:front', secondsAgo: 1 });
  await query('INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id) VALUES ($1, $2), ($3, $2)', [id('raw'), SCRAP, id('merge-source')]);

  // Local merge: merge-source's own rows resolve to merge-survivor.
  await insertRef('merge-source', 'universe', DEAD_UNI);
  await insertMedia('merge-source', 'merged-portrait', 'portrait');
  await query(`INSERT INTO catalog_ingredient_merges (id, source_id, survivor_id, before_state, after_fingerprint)
    VALUES ($1, $2, $3, '{}'::jsonb, 'fixture')`, [MERGE, id('merge-source'), id('merge-survivor')]);

  // Committed shared-identity operation owned by a peer survivor: the views read
  // the source's plan rows (priority 0) and the survivor snapshot (priority 2).
  const source = { refs: [refRow('op-source', 'universe', UNI)], media: [mediaRow('op-source', 'op-ref', 'reference')], sources: [{ ingredient_id: id('op-source'), scrap_id: SCRAP, span: null, extracted_at: now }] };
  const snapshot = { refs: [refRow('op-survivor', 'series', SER), refRow('op-survivor', 'creative-director', CD_DEAD)], media: [mediaRow('op-survivor', 'op-portrait', 'portrait')], sources: [] };
  await query(`INSERT INTO catalog_identity_operations (id, source_id, survivor_id, source_owner, survivor_owner, local_owner, state, plan, plan_hash, current_snapshot)
    VALUES ($1, $2, $3, 'list-test-local', 'list-test-peer', 'list-test-local', 'committed', $4::jsonb, 'fixture', $5::jsonb)`,
  [OP, id('op-source'), id('op-survivor'), JSON.stringify({ version: 1, source, survivor: snapshot }), JSON.stringify(snapshot)]);
});

afterAll(async () => {
  if (!ready) return;
  await query('DELETE FROM catalog_identity_operations WHERE id = $1', [OP]);
  await query('DELETE FROM catalog_ingredient_merges WHERE id = $1', [MERGE]);
  await query('DELETE FROM catalog_ingredients WHERE $1 = ANY(tags)', [TAG]);
  await query('DELETE FROM catalog_scraps WHERE id = $1', [SCRAP]);
  await query('DELETE FROM creative_director_projects WHERE id = $1', [CD_DEAD]);
  await query('DELETE FROM pipeline_series WHERE id = $1', [SER]);
  await query('DELETE FROM universes WHERE id = $1', [UNI]);
  await close();
});

const FILTERS = {
  none: {},
  unlinked: { unlinked: true },
  orphaned: { orphaned: true },
  universe: { refKind: 'universe', refId: UNI },
  series: { refKind: 'series', refId: SER },
  scrap: { scrapId: SCRAP },
};

const project = ({ items }) => items.map(({ id: itemId, thumbnailKey, usage }) => ({ id: itemId, thumbnailKey, usage }));

describe.skipIf(!ready)('listIngredients identity read views (#12989)', () => {
  // Uniquely catches a rewritten filter or decoration diverging from the
  // correlated statement on any view branch (live, merge, shared operation).
  it.each(Object.entries(FILTERS))('matches the correlated statement for the %s view', async (_label, filter) => {
    const current = project(await listIngredients({ ...filter, tag: TAG, limit: 200 }));
    expect(current).toEqual(await legacyList(filter));
    expect(current.length).toBeGreaterThan(0);
  });

  it('classifies the fixture the way the albums promise', async () => {
    const ids = async (filter) => project(await listIngredients({ ...filter, tag: TAG, limit: 200 })).map((row) => row.id);
    expect(await ids(FILTERS.orphaned)).toEqual([id('orphan')]);
    expect(await ids(FILTERS.universe)).toEqual([id('op-survivor'), id('mixed'), id('series-only'), id('linked')]);
    expect(await ids(FILTERS.scrap)).toEqual([id('op-survivor'), id('merge-survivor'), id('raw')]);
    const byId = new Map(project(await listIngredients({ tag: TAG, limit: 200 })).map((row) => [row.id, row]));
    expect(byId.get(id('linked'))).toEqual({ id: id('linked'), thumbnailKey: `${P}-new-ref`, usage: { universe: 1, issue: 1 } });
    expect(byId.get(id('thumbs')).thumbnailKey).toBe(`${P}-portrait`);
    expect(byId.get(id('op-survivor'))).toEqual({ id: id('op-survivor'), thumbnailKey: `${P}-op-portrait`, usage: { universe: 1, series: 1 } });
  });

  it('pages without changing order and decorates only the returned page', async () => {
    const all = project(await listIngredients({ tag: TAG, limit: 200 }));
    const pages = [];
    for (let offset = 0; offset < all.length; offset += 3) {
      const page = await listIngredients({ tag: TAG, limit: 3, offset });
      expect(page.nextOffset).toBe(offset + page.items.length);
      pages.push(...project(page));
    }
    expect(pages).toEqual(all);
  });

  // Uniquely catches a regression to per-row view evaluation: a correlated
  // subquery rescans the view's base tables once per outer row.
  it('evaluates each read view once per statement', async () => {
    const plans = [];
    for (const filter of [FILTERS.orphaned, FILTERS.unlinked, FILTERS.universe, FILTERS.scrap]) {
      query.mockClear();
      await listIngredients({ ...filter, limit: 50 });
      for (const [sql, params] of [...query.mock.calls]) {
        const { rows } = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        plans.push(rows[0]['QUERY PLAN'][0].Plan);
      }
    }
    const viewScans = [];
    const walk = (node) => {
      if (/^catalog_ingredient_(refs|media|sources)$/.test(node['Relation Name'] || '')) viewScans.push(node);
      for (const child of node.Plans || []) walk(child);
    };
    plans.forEach(walk);
    expect(viewScans.length).toBeGreaterThan(0);
    for (const node of viewScans) expect({ relation: node['Relation Name'], loops: node['Actual Loops'] }).toEqual({ relation: node['Relation Name'], loops: 1 });
  });
});
