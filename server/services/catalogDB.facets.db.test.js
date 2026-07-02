/**
 * Postgres-backed tests for the Catalog facet + album filters (#1762):
 *   - listIngredients({ refKind, refId })  — universe/series membership
 *   - listIngredients({ unlinked: true })  — the "Raw" album (no u/s ref)
 *   - listIngredients({ orphaned: true })  — refs whose target is gone
 *   - getCatalogFacets()                    — type/universe/series/tag facets +
 *                                             unlinked / orphaned bucket counts
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this). The DB is shared across worktrees, so assertions are RELATIVE
 * (membership + `>=`) and every row created here is torn down in afterAll.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import * as catalogDB from './catalogDB.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasCatalogSchema: false }));
    if (recheck.hasCatalogSchema) dbReady = true;
    else skipReason = 'catalog schema not present';
  }
}
if (!dbReady) console.log(`⏭️ catalogDB.facets.db.test: skipping suite — ${skipReason || 'no database'}`);

const nonce = `f${Date.now()}`;
const UNI_ID = `uni-${nonce}`;
const SER_ID = `ser-${nonce}`;
const DEAD_UNI_ID = `dead-uni-${nonce}`; // never inserted → orphaned target
const TAG = `tag-${nonce}`;
const createdIngredientIds = new Set();

beforeAll(async () => {
  if (!dbReady) return;
  await query('INSERT INTO universes (id, name) VALUES ($1, $2)', [UNI_ID, `Universe ${nonce}`]);
  await query('INSERT INTO pipeline_series (id, name, universe_id) VALUES ($1, $2, $3)', [SER_ID, `Series ${nonce}`, UNI_ID]);
});

afterAll(async () => {
  if (!dbReady) return;
  for (const id of createdIngredientIds) {
    await catalogDB.deleteIngredient(id, { hard: true }).catch(() => {});
  }
  await query('DELETE FROM catalog_ingredient_refs WHERE ref_id = ANY($1)', [[UNI_ID, SER_ID, DEAD_UNI_ID]]).catch(() => {});
  await query('DELETE FROM pipeline_series WHERE id = $1', [SER_ID]).catch(() => {});
  await query('DELETE FROM universes WHERE id = $1', [UNI_ID]).catch(() => {});
  await close();
});

describe.skipIf(!dbReady)('catalogDB facets + album filters (#1762)', () => {
  it('lists ingredients by universe ref (membership), composing with type', async () => {
    const linked = await catalogDB.createIngredient({ type: 'character', name: `Linked ${nonce}`, tags: [TAG] });
    const other = await catalogDB.createIngredient({ type: 'place', name: `Other ${nonce}` });
    createdIngredientIds.add(linked.id);
    createdIngredientIds.add(other.id);
    await catalogDB.linkIngredientToRef(linked.id, 'universe', UNI_ID, 'cast-character');

    const { items } = await catalogDB.listIngredients({ refKind: 'universe', refId: UNI_ID, limit: 200 });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(linked.id);
    expect(ids).not.toContain(other.id);

    // Composes with a type filter (still matches, since linked is a character).
    const typed = await catalogDB.listIngredients({ refKind: 'universe', refId: UNI_ID, type: 'character', limit: 200 });
    expect(typed.items.map((i) => i.id)).toContain(linked.id);
    // …and excludes when the type doesn't match.
    const typedMiss = await catalogDB.listIngredients({ refKind: 'universe', refId: UNI_ID, type: 'object', limit: 200 });
    expect(typedMiss.items.map((i) => i.id)).not.toContain(linked.id);
  });

  it('rolls a series-only ingredient up under its parent universe (decision #1)', async () => {
    const seriesOnly = await catalogDB.createIngredient({ type: 'character', name: `SeriesOnly ${nonce}` });
    createdIngredientIds.add(seriesOnly.id);
    // Linked ONLY to the series (which belongs to UNI) — no direct universe ref.
    await catalogDB.linkIngredientToRef(seriesOnly.id, 'series', SER_ID, 'cast-character');

    const { items } = await catalogDB.listIngredients({ refKind: 'universe', refId: UNI_ID, limit: 200 });
    expect(items.map((i) => i.id)).toContain(seriesOnly.id);

    // And the universe facet count reflects the rolled-up series member.
    const facets = await catalogDB.getCatalogFacets();
    const uni = facets.universes.find((u) => u.refId === UNI_ID);
    expect(uni.count).toBeGreaterThanOrEqual(1);
  });

  it('does not duplicate a row linked under multiple roles', async () => {
    const multi = await catalogDB.createIngredient({ type: 'character', name: `Multi ${nonce}` });
    createdIngredientIds.add(multi.id);
    await catalogDB.linkIngredientToRef(multi.id, 'universe', UNI_ID, 'cast-character');
    await catalogDB.linkIngredientToRef(multi.id, 'universe', UNI_ID, 'reference');

    const { items } = await catalogDB.listIngredients({ refKind: 'universe', refId: UNI_ID, limit: 200 });
    const occurrences = items.filter((i) => i.id === multi.id).length;
    expect(occurrences).toBe(1);
  });

  it('lists unlinked ("Raw") ingredients and excludes linked ones', async () => {
    const raw = await catalogDB.createIngredient({ type: 'idea', name: `Raw ${nonce}` });
    const linked = await catalogDB.createIngredient({ type: 'character', name: `RawLinked ${nonce}` });
    createdIngredientIds.add(raw.id);
    createdIngredientIds.add(linked.id);
    await catalogDB.linkIngredientToRef(linked.id, 'series', SER_ID, 'cast-character');

    const { items } = await catalogDB.listIngredients({ unlinked: true, limit: 1000 });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(raw.id);
    expect(ids).not.toContain(linked.id);
  });

  it('lists orphaned ingredients (ref present, target gone) and excludes live-linked', async () => {
    const orphan = await catalogDB.createIngredient({ type: 'object', name: `Orphan ${nonce}` });
    const live = await catalogDB.createIngredient({ type: 'object', name: `Live ${nonce}` });
    createdIngredientIds.add(orphan.id);
    createdIngredientIds.add(live.id);
    // orphan → points at a universe id that has no row; live → the real universe.
    await catalogDB.linkIngredientToRef(orphan.id, 'universe', DEAD_UNI_ID, 'reference');
    await catalogDB.linkIngredientToRef(live.id, 'universe', UNI_ID, 'reference');

    const { items } = await catalogDB.listIngredients({ orphaned: true, limit: 1000 });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(live.id);
    // An orphan is, by definition, NOT in the unlinked set (it has a ref).
    const raw = await catalogDB.listIngredients({ unlinked: true, limit: 1000 });
    expect(raw.items.map((i) => i.id)).not.toContain(orphan.id);
  });

  it('classifies creative-director refs as homing: live → linked, soft-deleted → orphaned (#1812)', async () => {
    const cdId = `cd-${nonce}`;
    await query('INSERT INTO creative_director_projects (id, data) VALUES ($1, $2::jsonb)', [cdId, '{}']);
    const cdLinked = await catalogDB.createIngredient({ type: 'object', name: `CDLinked ${nonce}` });
    createdIngredientIds.add(cdLinked.id);
    await catalogDB.linkIngredientToRef(cdLinked.id, 'creative-director', cdId, 'reference');

    // While the CD project is live, the ingredient is LINKED — not unlinked (it
    // has a homing ref) and not orphaned (the target resolves).
    let unlinked = await catalogDB.listIngredients({ unlinked: true, limit: 1000 });
    expect(unlinked.items.map((i) => i.id)).not.toContain(cdLinked.id);
    let orphaned = await catalogDB.listIngredients({ orphaned: true, limit: 1000 });
    expect(orphaned.items.map((i) => i.id)).not.toContain(cdLinked.id);

    // Soft-delete the CD project → the ref dangles → the ingredient is ORPHANED
    // (surfaces in the Orphaned album for re-linking), still not unlinked.
    await query('UPDATE creative_director_projects SET deleted = TRUE, deleted_at = NOW() WHERE id = $1', [cdId]);
    orphaned = await catalogDB.listIngredients({ orphaned: true, limit: 1000 });
    expect(orphaned.items.map((i) => i.id)).toContain(cdLinked.id);
    unlinked = await catalogDB.listIngredients({ unlinked: true, limit: 1000 });
    expect(unlinked.items.map((i) => i.id)).not.toContain(cdLinked.id);

    await query('DELETE FROM catalog_ingredient_refs WHERE ref_id = $1', [cdId]).catch(() => {});
    await query('DELETE FROM creative_director_projects WHERE id = $1', [cdId]).catch(() => {});
  });

  it('getCatalogFacets aggregates type/universe/series/tag facets + bucket counts', async () => {
    const linked = await catalogDB.createIngredient({ type: 'character', name: `FacetLinked ${nonce}`, tags: [TAG] });
    const seriesLinked = await catalogDB.createIngredient({ type: 'character', name: `FacetSeries ${nonce}` });
    const raw = await catalogDB.createIngredient({ type: 'idea', name: `FacetRaw ${nonce}` });
    const orphan = await catalogDB.createIngredient({ type: 'object', name: `FacetOrphan ${nonce}` });
    [linked, seriesLinked, raw, orphan].forEach((i) => createdIngredientIds.add(i.id));
    await catalogDB.linkIngredientToRef(linked.id, 'universe', UNI_ID, 'cast-character');
    await catalogDB.linkIngredientToRef(seriesLinked.id, 'series', SER_ID, 'cast-character');
    await catalogDB.linkIngredientToRef(orphan.id, 'universe', DEAD_UNI_ID, 'reference');

    const facets = await catalogDB.getCatalogFacets();

    // Live universe + series appear with their resolved names + counts.
    const uni = facets.universes.find((u) => u.refId === UNI_ID);
    expect(uni).toBeTruthy();
    expect(uni.name).toBe(`Universe ${nonce}`);
    expect(uni.count).toBeGreaterThanOrEqual(1);

    const ser = facets.series.find((s) => s.refId === SER_ID);
    expect(ser).toBeTruthy();
    expect(ser.name).toBe(`Series ${nonce}`);
    expect(ser.universeId).toBe(UNI_ID);
    expect(ser.count).toBeGreaterThanOrEqual(1);

    // A dangling-target universe never appears in the live facet array.
    expect(facets.universes.find((u) => u.refId === DEAD_UNI_ID)).toBeUndefined();

    // Tag + type facets surface our nonce tag and the character type.
    expect(facets.tags.find((t) => t.tag === TAG)?.count).toBeGreaterThanOrEqual(1);
    expect(facets.types.find((t) => t.type === 'character')?.count).toBeGreaterThanOrEqual(2);

    // Bucket counts: our raw + orphan each push their bucket up by >=1.
    expect(facets.unlinkedCount).toBeGreaterThanOrEqual(1);
    expect(facets.orphanedCount).toBeGreaterThanOrEqual(1);
    expect(facets.total).toBeGreaterThanOrEqual(4);
  });
});
