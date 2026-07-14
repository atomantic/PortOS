/**
 * Creative Ingredients Catalog — source links, external refs & relations.
 *
 * Three edge tables around ingredients:
 *   - catalog_ingredient_sources: ingredient ↔ scrap provenance links.
 *   - catalog_ingredient_refs:    ingredient ↔ external record (universe /
 *     series / creative-director / issue / work), each with a role.
 *   - catalog_ingredient_relations: directed ingredient ↔ ingredient edges.
 *
 * Unlink is a soft-delete so the tombstone propagates to peers.
 */

import { query } from '../../lib/db.js';
import { resolveRefs } from '../catalogRefResolver.js';
import { rowToRef, rowToSource, rowToIngredient } from './shared.js';

// `{ client }` is optional — see the createIngredient comment. Passing the same
// client used to insert the ingredient row keeps the source-link row in the
// same transaction so a mid-batch failure rolls back both halves.
export async function linkIngredientToSource(ingredientId, scrapId, span = null, { client } = {}) {
  const exec = client ? client.query.bind(client) : query;
  await exec(
    `INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id, span)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (ingredient_id, scrap_id) DO UPDATE SET span = EXCLUDED.span`,
    [ingredientId, scrapId, span ? JSON.stringify(span) : null],
  );
}

export async function listSourcesForIngredient(ingredientId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_sources WHERE ingredient_id = $1`,
    [ingredientId],
  );
  return result.rows.map(rowToSource);
}

export async function listSourcesForScrap(scrapId) {
  const result = await query(
    `SELECT * FROM catalog_ingredient_sources WHERE scrap_id = $1`,
    [scrapId],
  );
  return result.rows.map(rowToSource);
}

export async function linkIngredientToRef(ingredientId, refKind, refId, role) {
  // ON CONFLICT DO UPDATE revives a soft-deleted row instead of leaving it
  // tombstoned. The trigger only bumps sync_sequence when `deleted` or
  // `deleted_at` actually change, so a link-on-active-row stays a no-op for
  // peers (no spurious sync event).
  await query(
    `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
       SET deleted = false, deleted_at = NULL`,
    [ingredientId, refKind, refId, role],
  );
}

// Catalog ingredient `type` → series ref role (#1761). Anything outside this
// map (idea/scene/user-defined types) links as a generic 'mentioned' ref.
// Lives here, next to the link primitive, so every remix target that attaches
// ingredients to a series shares one role vocabulary instead of inlining its own.
const SERIES_REF_ROLE_BY_TYPE = Object.freeze({
  character: 'cast',
  place: 'canon-place',
  object: 'canon-object',
});
export const seriesRefRoleForType = (type) => SERIES_REF_ROLE_BY_TYPE[type] || 'mentioned';

// Link a batch of already-resolved catalog ingredients to a series via
// catalog_ingredient_refs (#1761) — the convergence contract's single data
// model. The inserts are mutually independent, so they fan out. Returns the
// ingredients actually linked (those with an id).
export async function linkIngredientsToSeries(seriesId, ingredients = []) {
  const list = Array.isArray(ingredients) ? ingredients.filter((ing) => ing && ing.id) : [];
  if (list.length === 0) return [];
  await Promise.all(list.map((ing) => linkIngredientToRef(ing.id, 'series', seriesId, seriesRefRoleForType(ing.type))));
  return list;
}

// Catalog ingredient `type` → Creative Director ref role (#1808). CD projects
// reuse the same convergence data model (catalog_ingredient_refs) as series; the
// role vocabulary is CD-flavored (location/prop) so the Catalog "Appears in"
// panel and any future casting UI can label a CD link meaningfully. Anything
// outside this map (idea/concept/user-defined types) links as a generic
// 'reference'. Lives next to seriesRefRoleForType so every remix target shares
// one role-vocabulary home.
const CD_REF_ROLE_BY_TYPE = Object.freeze({
  character: 'cast',
  place: 'location',
  object: 'prop',
  scene: 'scene',
});
export const cdRefRoleForType = (type) => CD_REF_ROLE_BY_TYPE[type] || 'reference';

// Link a batch of already-resolved catalog ingredients to a Creative Director
// project via catalog_ingredient_refs with ref_kind='creative-director' (#1808)
// — the reserved-but-previously-unwritten ref kind. Mirrors
// linkIngredientsToSeries; the inserts are independent so they fan out. Returns
// the ingredients actually linked (those with an id).
export async function linkIngredientsToCreativeDirector(projectId, ingredients = []) {
  const list = Array.isArray(ingredients) ? ingredients.filter((ing) => ing && ing.id) : [];
  if (list.length === 0) return [];
  await Promise.all(list.map((ing) => linkIngredientToRef(ing.id, 'creative-director', projectId, cdRefRoleForType(ing.type))));
  return list;
}

export async function unlinkIngredientFromRef(ingredientId, refKind, refId, role) {
  // Soft-delete via UPDATE so the row stays around as a tombstone and the
  // trg_catalog_ref_sync_seq trigger bumps sync_sequence — peers pick the
  // unlink up on their next pull. The `AND deleted = false` filter keeps
  // re-unlinks from re-bumping sync_sequence unnecessarily.
  await query(
    `UPDATE catalog_ingredient_refs
        SET deleted = true, deleted_at = NOW()
      WHERE ingredient_id = $1 AND ref_kind = $2 AND ref_id = $3 AND role = $4
        AND deleted = false`,
    [ingredientId, refKind, refId, role],
  );
}

export async function listRefsForIngredient(ingredientId) {
  // Filter `deleted = false` so the "Appears in" panel doesn't surface
  // tombstoned unlinks. Tombstones are read-only state for sync purposes;
  // user-facing list paths only show live links.
  const result = await query(
    `SELECT * FROM catalog_ingredient_refs WHERE ingredient_id = $1 AND deleted = false`,
    [ingredientId],
  );
  return result.rows.map(rowToRef);
}

// Like listRefsForIngredient, but drops refs whose TARGET no longer resolves to
// a live record (#1812). A ref row stays live (`deleted = false`) when its
// universe/series/creative-director/issue/work target is soft-deleted — that's
// intentional (the orphan is recoverable via the Orphaned album) — but the
// detail page's "Appears in" panel must not render a chip that deep-links to a
// 404'd target. Resolution goes through the shared resolver (REF_TARGET_TABLES),
// so every ref kind is filtered uniformly. resolveRefs preserves input order and
// de-dupes its target probes, so the filter is a positional zip.
export async function listLiveRefsForIngredient(ingredientId) {
  const refs = await listRefsForIngredient(ingredientId);
  if (refs.length === 0) return refs;
  const resolved = await resolveRefs(refs);
  return refs.filter((_, i) => resolved[i]?.resolved === true);
}

export async function listIngredientsForRef(refKind, refId) {
  const result = await query(
    `SELECT i.*, r.role, r.created_at AS ref_created_at
       FROM catalog_ingredients i
       JOIN catalog_ingredient_refs r ON r.ingredient_id = i.id
       WHERE r.ref_kind = $1 AND r.ref_id = $2
         AND r.deleted = false AND i.deleted = false`,
    [refKind, refId],
  );
  return result.rows.map((row) => ({ ingredient: rowToIngredient(row), role: row.role }));
}


// --- Ingredient↔ingredient relations -----------------------------------
// Directed edges (from_id → to_id, kind). Soft-deleted on unlink so peers
// receive the tombstone. ON CONFLICT DO UPDATE revives a soft-deleted edge
// (the trg_catalog_relation_sync_seq trigger bumps sync_sequence only when
// deleted/deleted_at actually change, so a link-on-active-row stays a no-op).

export async function linkIngredientRelation(fromId, toId, kind) {
  if (fromId === toId) throw new Error('cannot relate an ingredient to itself');
  await query(
    `INSERT INTO catalog_ingredient_relations (from_id, to_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_id, to_id, kind) DO UPDATE
       SET deleted = false, deleted_at = NULL`,
    [fromId, toId, kind],
  );
}

export async function unlinkIngredientRelation(fromId, toId, kind) {
  // Soft-delete (mirrors unlinkIngredientFromRef): keep the row as a tombstone
  // so the sync_sequence bump propagates the unlink to peers. `AND deleted =
  // false` keeps a re-unlink from re-bumping the sequence needlessly.
  await query(
    `UPDATE catalog_ingredient_relations
        SET deleted = true, deleted_at = NOW()
      WHERE from_id = $1 AND to_id = $2 AND kind = $3
        AND deleted = false`,
    [fromId, toId, kind],
  );
}

// Both directions for one ingredient's detail "Relations" panel. Outbound
// (from_id = id) and inbound (to_id = id) are returned separately so the UI
// can render each with the correct directional label. Joins the OTHER end's
// ingredient name/type so the chip reads without a second fetch. Live edges
// only (deleted = false on both the edge and the joined ingredient).
export async function listRelationsForIngredient(id) {
  const [outbound, inbound] = await Promise.all([
    query(
      `SELECT r.from_id, r.to_id, r.kind, r.created_at,
              i.name AS other_name, i.type AS other_type
         FROM catalog_ingredient_relations r
         JOIN catalog_ingredients i ON i.id = r.to_id
        WHERE r.from_id = $1 AND r.deleted = false AND i.deleted = false
        ORDER BY r.created_at ASC`,
      [id],
    ),
    query(
      `SELECT r.from_id, r.to_id, r.kind, r.created_at,
              i.name AS other_name, i.type AS other_type
         FROM catalog_ingredient_relations r
         JOIN catalog_ingredients i ON i.id = r.from_id
        WHERE r.to_id = $1 AND r.deleted = false AND i.deleted = false
        ORDER BY r.created_at ASC`,
      [id],
    ),
  ]);
  const mapRow = (row, otherId) => ({
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    other: { id: otherId, name: row.other_name, type: row.other_type },
  });
  return {
    outbound: outbound.rows.map((row) => mapRow(row, row.to_id)),
    inbound: inbound.rows.map((row) => mapRow(row, row.from_id)),
  };
}
