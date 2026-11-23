/**
 * Creative Ingredients Catalog — export bundles, stats & facets.
 *
 * The user-facing export slice (`exportSliceForRef`, embeddings stripped) and
 * the sync bundle (`getCatalogBundleForRef`, embeddings + tombstones kept) for
 * one external ref, plus the aggregate stats + faceted counts that drive the
 * Catalog filter dropdowns and album headers.
 */

import { query } from '../../lib/db.js';
import { rowToRef, rowToSource, rowToIngredient, HOMING_REF_KINDS_SQL, groupRowsByIngredient } from './shared.js';
import { listIngredientsForRef, listRefsForIngredients } from './refs.js';
import { listMediaForIngredients } from './media.js';

const rowToExportScrap = (row) => ({
  id: row.id,
  title: row.title,
  rawText: row.raw_text,
  sourceKind: row.source_kind,
  metadata: row.metadata || {},
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * Hydrate one ingredient with its live scraps for the export bundle, oldest
 * first. Returns `[]` when an ingredient has no sources.
 */
export async function listScrapsForIngredient(ingredientId) {
  const byIngredient = await listScrapsForIngredients([ingredientId]);
  return byIngredient.get(ingredientId);
}

// Batched `listScrapsForIngredient` for bulk hydration paths (#3940) — ONE
// query for N ingredients instead of N. `src.ingredient_id` comes back on each
// row purely to group by; the outer sort key doesn't disturb the per-ingredient
// `created_at ASC` order. Returns `Map<ingredientId, scraps[]>` with an entry
// (possibly `[]`) for every id.
export async function listScrapsForIngredients(ingredientIds, { includeRetained = false } = {}) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT src.ingredient_id, s.id, s.title, s.raw_text, s.source_kind, s.metadata,
            s.created_at, s.updated_at
       FROM catalog_scraps s
       JOIN ${includeRetained ? 'catalog_identity_read_sources' : 'catalog_ingredient_sources'} src ON src.scrap_id = s.id
      WHERE src.ingredient_id = ANY($1)
        AND s.deleted = false
      ORDER BY src.ingredient_id, s.created_at ASC`,
    [ids],
  );
  return groupRowsByIngredient(ids, result.rows, rowToExportScrap);
}

// Source provenance survives even when a foreign scrap's body was never copied.
async function listExportSourcesForIngredients(ingredientIds) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT * FROM catalog_identity_read_sources
      WHERE ingredient_id = ANY($1) ORDER BY ingredient_id, extracted_at ASC`,
    [ids],
  );
  return groupRowsByIngredient(ids, result.rows, row => {
    const { syncSequence: _syncSequence, ...source } = rowToSource(row);
    return source;
  });
}

/**
 * Build an export bundle for one ref (universe/series/issue/work).
 * Hydrates each ingredient + its scraps + ref links + media attachments. The
 * media bundle carries `media_key` REFERENCES (not bytes) — a receiving peer
 * matches each key against its own library and surfaces unresolved ones via
 * the metadata-missing integrity surface. Relations are still omitted here
 * (see `[catalog-ingredient-relations]`); when they land, extend this helper.
 */
export async function exportSliceForRef(refKind, refId) {
  const rows = await listIngredientsForRef(refKind, refId, { preserveIdentity: true, includeRetained: true });
  // Hydrate the whole slice in batches (#3940), including source links whose
  // scrap bodies are unavailable locally. Five queries total, regardless of N.
  const ingredientIds = rows.map(({ ingredient }) => ingredient.id);
  const [scrapsById, refsById, mediaById, sourcesById] = await Promise.all([
    listScrapsForIngredients(ingredientIds, { includeRetained: true }),
    listRefsForIngredients(ingredientIds, { preserveIdentity: true, includeRetained: true }),
    listMediaForIngredients(ingredientIds, { preserveIdentity: true, includeRetained: true }),
    listExportSourcesForIngredients(ingredientIds),
  ]);
  const ingredients = rows.map(({ ingredient, role }) => {
    const { embedding: _embedding, ...rest } = ingredient;
    return {
      ...rest,
      // The role this ingredient plays for the queried ref — handy for
      // round-trip re-imports that want to preserve roleness without
      // re-deriving it from the full refs list.
      roleForExportedRef: role,
      refs: refsById.get(ingredient.id) || [],
      scraps: scrapsById.get(ingredient.id) || [],
      sources: sourcesById.get(ingredient.id) || [],
      media: mediaById.get(ingredient.id) || [],
    };
  });
  return {
    version: 1,
    ref: { kind: refKind, id: refId },
    exportedAt: new Date().toISOString(),
    ingredients,
  };
}

/**
 * Wire-shaped catalog bundle for one external ref (universe/series/issue/work),
 * for piggy-backing on a peer RECORD push (e.g. a universe push carries the
 * catalog rows referenced by its embedded canon). Unlike `exportSliceForRef`
 * (a user-facing export that strips embeddings + tombstones) this is a SYNC
 * payload:
 *
 *   - `ingredients` carry their `embedding` + tombstone fields, so the
 *     receiver gets the full enriched row (tags, embedding, payload.summary)
 *     rather than re-deriving a strictly-lossy view from the embedded canon.
 *   - `refs` include TOMBSTONED rows (deleted = true) so an unlink propagates
 *     with the push — the "Appears in" panel converges across peers.
 *
 * Shapes match `catalogSyncIngredientSchema` / `catalogSyncRefSchema`, so the
 * receiver applies them straight through `catalogSync.applyRemoteChanges`.
 */
export async function getCatalogBundleForRef(refKind, refId) {
  // Every ref row for this target — live AND tombstoned (no `deleted = false`
  // filter, unlike listRefsForIngredient) so unlinks ride the bundle.
  const refResult = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE ref_kind = $1 AND ref_id = $2`,
    [refKind, refId],
  );
  const refs = refResult.rows.map(rowToRef);

  // Hydrate each referenced ingredient WITH embedding + tombstone state. A
  // tombstoned ref still names a (possibly live) ingredient — include it so
  // the receiver has the enriched row even if its own ref is being removed.
  const ingredientIds = [...new Set(refs.map((r) => r.ingredientId))];
  let ingredients = [];
  if (ingredientIds.length > 0) {
    const ingResult = await query(
      `SELECT * FROM catalog_ingredients WHERE id = ANY($1)`,
      [ingredientIds],
    );
    ingredients = ingResult.rows.map(rowToIngredient);
  }
  return { ingredients, refs };
}

/**
 * Which of `ingredientIds` already have a local row (live or tombstoned), and
 * which of those already carry a local ref (live or tombstoned) to
 * `refKind`/`refId`. A peer-push receiver uses it to refuse a bundled
 * ingredient that belongs to another record (#12466).
 */
export async function getLocalIngredientRefOwnership(ingredientIds, refKind, refId) {
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return { existing: new Set(), linked: new Set() };
  const [ingResult, refResult] = await Promise.all([
    query(`SELECT id FROM catalog_ingredients WHERE id = ANY($1)`, [ids]),
    query(
      `SELECT DISTINCT ingredient_id FROM catalog_ingredient_refs
        WHERE ingredient_id = ANY($1) AND ref_kind = $2 AND ref_id = $3`,
      [ids, refKind, refId],
    ),
  ]);
  return {
    existing: new Set(ingResult.rows.map((row) => row.id)),
    linked: new Set(refResult.rows.map((row) => row.ingredient_id)),
  };
}

export async function getCatalogStats() {
  const [byTypeResult, scrapResult, withEmb] = await Promise.all([
    query(`SELECT type, COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false AND id = catalog_canonical_ingredient_id(id) GROUP BY type`),
    // Count only parent/standalone scraps — child chunk rows are an internal
    // extraction detail and would inflate the user-facing scrap count.
    query(`SELECT COUNT(*) AS count FROM catalog_scraps WHERE deleted = false AND parent_scrap_id IS NULL`),
    query(`SELECT COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false AND id = catalog_canonical_ingredient_id(id) AND embedding IS NOT NULL`),
  ]);
  const byType = {};
  let total = 0;
  for (const r of byTypeResult.rows) {
    byType[r.type] = parseInt(r.count, 10);
    total += parseInt(r.count, 10);
  }
  return {
    total,
    byType,
    scraps: parseInt(scrapResult.rows[0].count, 10),
    withEmbeddings: parseInt(withEmb.rows[0].count, 10),
  };
}

// Faceted counts driving the Catalog filter dropdowns + album headers (#1762)
// in one round-trip. Distinguishes three mutually-exclusive per-ingredient
// buckets: LINKED (≥1 live universe/series ref — rolls up into the universes/
// series facet arrays), UNLINKED (no universe/series ref at all → "Raw" album),
// and ORPHANED (has a universe/series ref but none resolve to a live target →
// "Orphaned" album). Only live universes/series appear in the facet arrays; the
// joins on `deleted = false` enforce the same live predicate the resolver uses.
// Single statement: see getCatalogFacets.
const FACETS_SQL = `
    WITH live_ingredients AS MATERIALIZED (
           SELECT id, type, tags FROM catalog_ingredients
            WHERE deleted = false AND id = catalog_canonical_ingredient_id(id)),
         canonical_refs AS MATERIALIZED (
           SELECT r.cid, r.ref_kind, r.ref_id
             FROM (SELECT catalog_canonical_ingredient_id(ingredient_id) AS cid, ref_kind, ref_id
                     FROM catalog_identity_read_refs WHERE deleted = false) r
             JOIN live_ingredients li ON li.id = r.cid),
         live_universes AS (SELECT id, name FROM universes WHERE deleted = false),
         live_series AS (SELECT id, name, universe_id FROM pipeline_series WHERE deleted = false),
         live_cd AS (SELECT id FROM creative_director_projects WHERE deleted = false),
         uni_members AS (
           SELECT r.ref_id AS uid, r.cid FROM canonical_refs r WHERE r.ref_kind = 'universe'
           UNION
           SELECT s.universe_id, r.cid FROM canonical_refs r
             JOIN live_series s ON s.id = r.ref_id WHERE r.ref_kind = 'series'),
         uni_counts AS (
           SELECT u.id AS ref_id, u.name, COUNT(*)::int AS count
             FROM uni_members m JOIN live_universes u ON u.id = m.uid GROUP BY u.id, u.name),
         ser_counts AS (
           SELECT s.id AS ref_id, s.name, s.universe_id, COUNT(DISTINCT r.cid)::int AS count
             FROM canonical_refs r JOIN live_series s ON s.id = r.ref_id
            WHERE r.ref_kind = 'series' GROUP BY s.id, s.name, s.universe_id),
         type_counts AS (SELECT type, COUNT(*)::int AS count FROM live_ingredients GROUP BY type),
         tag_counts AS (
           SELECT tag, COUNT(*)::int AS count FROM (SELECT unnest(tags) AS tag FROM live_ingredients) t GROUP BY tag),
         per_ingredient AS (
           SELECT li.id,
                  COUNT(r.ref_id) AS ref_count,
                  COUNT(r.ref_id) FILTER (WHERE lu.id IS NOT NULL OR ls.id IS NOT NULL OR lc.id IS NOT NULL) AS live_count
             FROM live_ingredients li
             LEFT JOIN canonical_refs r ON r.cid = li.id AND r.ref_kind IN (${HOMING_REF_KINDS_SQL})
             LEFT JOIN live_universes lu ON r.ref_kind = 'universe' AND lu.id = r.ref_id
             LEFT JOIN live_series ls ON r.ref_kind = 'series' AND ls.id = r.ref_id
             LEFT JOIN live_cd lc ON r.ref_kind = 'creative-director' AND lc.id = r.ref_id
            GROUP BY li.id)
    SELECT
      (SELECT COALESCE(json_agg(t ORDER BY t.count DESC, t.type), '[]'::json) FROM type_counts t) AS types,
      (SELECT COALESCE(json_agg(u ORDER BY u.count DESC, u.name), '[]'::json) FROM uni_counts u) AS universes,
      (SELECT COALESCE(json_agg(s ORDER BY s.count DESC, s.name), '[]'::json) FROM ser_counts s) AS series,
      (SELECT COALESCE(json_agg(g ORDER BY g.count DESC, g.tag), '[]'::json) FROM tag_counts g) AS tags,
      (SELECT COUNT(*) FILTER (WHERE ref_count = 0)::int FROM per_ingredient) AS unlinked,
      (SELECT COUNT(*) FILTER (WHERE ref_count > 0 AND live_count = 0)::int FROM per_ingredient) AS orphaned`;

export function getCatalogFacetsSql() {
  return FACETS_SQL;
}

export async function getCatalogFacets() {
  // ONE statement over two materialized bases, so catalog_ingredients and the
  // identity ref view are each scanned once (#17753). Membership and liveness
  // are hash joins, not correlated EXISTS/IN subplans (the #12989 pattern):
  //  - universe membership rolls up its series' members (decision #1): direct
  //    universe refs UNION refs to a live series under the universe, so the
  //    album header count matches what the universe album/filter actually lists.
  //  - bucket: ref_count = homing ref ROWS (universe/series/creative-director);
  //    live_count = those whose target still resolves. unlinked = ref_count 0;
  //    orphaned = ref_count > 0 but live_count 0; linked = live_count > 0.
  //    Same homing-ref set + live predicate as the listIngredients filters.
  const { rows } = await query(FACETS_SQL);
  const row = rows[0];
  const types = row.types.map((r) => ({ type: r.type, count: r.count }));
  return {
    types,
    universes: row.universes.map((r) => ({ refId: r.ref_id, name: r.name, count: r.count })),
    series: row.series.map((r) => ({ refId: r.ref_id, name: r.name, universeId: r.universe_id, count: r.count })),
    tags: row.tags.map((r) => ({ tag: r.tag, count: r.count })),
    unlinkedCount: row.unlinked ?? 0,
    orphanedCount: row.orphaned ?? 0,
    total: types.reduce((sum, t) => sum + t.count, 0),
  };
}
