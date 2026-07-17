/**
 * Creative Ingredients Catalog — export bundles, stats & facets.
 *
 * The user-facing export slice (`exportSliceForRef`, embeddings stripped) and
 * the sync bundle (`getCatalogBundleForRef`, embeddings + tombstones kept) for
 * one external ref, plus the aggregate stats + faceted counts that drive the
 * Catalog filter dropdowns and album headers.
 */

import { query } from '../../lib/db.js';
import { rowToRef, rowToIngredient, liveHomingTargetSql, HOMING_REF_KINDS_SQL } from './shared.js';
import { listIngredientsForRef, listRefsForIngredient } from './refs.js';
import { listMediaForIngredient } from './media.js';

/**
 * Hydrate one ingredient with its scraps for the export bundle. Issues two
 * queries: the sources join to look up the scrap ids, then a single batch
 * lookup of those scraps. Returns `[]` when an ingredient has no sources.
 */
export async function listScrapsForIngredient(ingredientId) {
  const result = await query(
    `SELECT s.id, s.title, s.raw_text, s.source_kind, s.metadata,
            s.created_at, s.updated_at
       FROM catalog_scraps s
       JOIN catalog_ingredient_sources src ON src.scrap_id = s.id
      WHERE src.ingredient_id = $1
        AND s.deleted = false
      ORDER BY s.created_at ASC`,
    [ingredientId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    sourceKind: row.source_kind,
    metadata: row.metadata || {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
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
  const rows = await listIngredientsForRef(refKind, refId);
  // Hydrate scraps + refs + media in parallel per ingredient. Small N (one
  // slice is typically <100 ingredients); a per-row round-trip is fine.
  const ingredients = await Promise.all(rows.map(async ({ ingredient, role }) => {
    const [scraps, refs, media] = await Promise.all([
      listScrapsForIngredient(ingredient.id),
      listRefsForIngredient(ingredient.id),
      listMediaForIngredient(ingredient.id),
    ]);
    const { embedding: _embedding, ...rest } = ingredient;
    return {
      ...rest,
      // The role this ingredient plays for the queried ref — handy for
      // round-trip re-imports that want to preserve roleness without
      // re-deriving it from the full refs list.
      roleForExportedRef: role,
      refs,
      scraps,
      media,
    };
  }));
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

export async function getCatalogStats() {
  const [byTypeResult, scrapResult, withEmb] = await Promise.all([
    query(`SELECT type, COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false GROUP BY type`),
    // Count only parent/standalone scraps — child chunk rows are an internal
    // extraction detail and would inflate the user-facing scrap count.
    query(`SELECT COUNT(*) AS count FROM catalog_scraps WHERE deleted = false AND parent_scrap_id IS NULL`),
    query(`SELECT COUNT(*) AS count FROM catalog_ingredients WHERE deleted = false AND embedding IS NOT NULL`),
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
export async function getCatalogFacets() {
  const [typeRows, uniRows, serRows, tagRows, bucketRows] = await Promise.all([
    query(`SELECT type, COUNT(*)::int AS count
             FROM catalog_ingredients WHERE deleted = false
            GROUP BY type ORDER BY count DESC, type`),
    // Universe membership rolls up its series' members (decision #1), so the
    // album header count matches what the universe album/filter actually lists:
    // distinct ingredients linked to the universe OR to a live series under it.
    query(`SELECT u.id AS ref_id, u.name, COUNT(DISTINCT r.ingredient_id)::int AS count
             FROM universes u
             JOIN catalog_ingredient_refs r ON r.deleted = false AND (
                  (r.ref_kind = 'universe' AND r.ref_id = u.id)
                  OR (r.ref_kind = 'series' AND r.ref_id IN (
                        SELECT s.id FROM pipeline_series s WHERE s.universe_id = u.id AND s.deleted = false)))
             JOIN catalog_ingredients i ON i.id = r.ingredient_id AND i.deleted = false
            WHERE u.deleted = false
            GROUP BY u.id, u.name ORDER BY count DESC, u.name`),
    query(`SELECT s.id AS ref_id, s.name, s.universe_id, COUNT(DISTINCT r.ingredient_id)::int AS count
             FROM catalog_ingredient_refs r
             JOIN catalog_ingredients i ON i.id = r.ingredient_id AND i.deleted = false
             JOIN pipeline_series s ON s.id = r.ref_id AND s.deleted = false
            WHERE r.deleted = false AND r.ref_kind = 'series'
            GROUP BY s.id, s.name, s.universe_id ORDER BY count DESC, s.name`),
    query(`SELECT tag, COUNT(*)::int AS count
             FROM (SELECT unnest(tags) AS tag FROM catalog_ingredients WHERE deleted = false) t
            GROUP BY tag ORDER BY count DESC, tag`),
    // Per-ingredient bucket classification. ref_count = live homing ref ROWS
    // (universe/series/creative-director); live_count = those whose target still
    // resolves. unlinked = ref_count 0; orphaned = ref_count > 0 but live_count 0;
    // linked = live_count > 0. Same homing-ref set + live predicate as the
    // listIngredients orphaned/unlinked filters, so the bucket counts and the
    // album listings can't drift.
    query(`SELECT
              COUNT(*) FILTER (WHERE ref_count = 0)::int AS unlinked,
              COUNT(*) FILTER (WHERE ref_count > 0 AND live_count = 0)::int AS orphaned,
              COUNT(*) FILTER (WHERE live_count > 0)::int AS linked
            FROM (
              SELECT i.id,
                COUNT(r.ref_id) AS ref_count,
                COUNT(r.ref_id) FILTER (WHERE ${liveHomingTargetSql('r')}) AS live_count
              FROM catalog_ingredients i
              LEFT JOIN catalog_ingredient_refs r
                ON r.ingredient_id = i.id AND r.deleted = false AND r.ref_kind IN (${HOMING_REF_KINDS_SQL})
              WHERE i.deleted = false
              GROUP BY i.id
            ) sub`),
  ]);
  const types = typeRows.rows.map((r) => ({ type: r.type, count: r.count }));
  const total = types.reduce((sum, t) => sum + t.count, 0);
  const buckets = bucketRows.rows[0] || {};
  return {
    types,
    universes: uniRows.rows.map((r) => ({ refId: r.ref_id, name: r.name, count: r.count })),
    series: serRows.rows.map((r) => ({ refId: r.ref_id, name: r.name, universeId: r.universe_id, count: r.count })),
    tags: tagRows.rows.map((r) => ({ tag: r.tag, count: r.count })),
    unlinkedCount: buckets.unlinked ?? 0,
    orphanedCount: buckets.orphaned ?? 0,
    total,
  };
}
