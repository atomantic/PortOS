/**
 * Catalog user-defined types — PostgreSQL backend (#1001).
 *
 * One row per type in `catalog_user_types`: `id` PK, the full definition in
 * `data` JSONB, and updated_at / deleted_at mirrored into columns (the
 * federation LWW clock + tombstone). Reads return `data` verbatim so callers
 * (the CRUD routes, the sync merge, `setUserCatalogTypes`) see the exact same
 * `{ id, label, primaryContentKey, fields, updatedAt?, deletedAt? }` shape the
 * settings slice gave — the columns are a queryable mirror, never read back.
 *
 * Concurrency: single-user install, but the early boot warm, a sync pull, and a
 * route write can still overlap. `writeUserTypes` is whole-slice authoritative,
 * so it runs in one transaction (upsert everything in the list + delete any row
 * whose id left the list) — a partial apply can't leave the table half-updated.
 */

import { query, withTransaction } from '../../lib/db.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

function rowToType(row) {
  // `data` already holds id/label/primaryContentKey/fields/updatedAt/deletedAt;
  // return it verbatim so the shape matches the settings backend exactly.
  return row.data;
}

/**
 * Full user-type slice (live + tombstones), verbatim. Ordered created_at ASC
 * then id so the active registry's user-type display order is stable across
 * reads (the settings slice was insertion-ordered; created_at preserves that).
 */
export async function readUserTypes() {
  const { rows } = await query(
    `SELECT data FROM catalog_user_types ORDER BY created_at ASC, id ASC`,
  );
  return rows.map(rowToType);
}

/**
 * Persist the whole user-type slice as the authoritative end state: upsert
 * every entry in `list`, then delete any DB row whose id is no longer present.
 * A null/non-array clears the table (matches the settings backend writing `[]`).
 * `deleted_at` is the tombstone column — a deleted-but-retained entry (with a
 * `deletedAt` in its data) stays a row so the deletion keeps federating.
 */
export async function writeUserTypes(list) {
  const types = Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string' && t.id) : [];
  await withTransaction(async (client) => {
    const exec = client.query.bind(client);
    const keepIds = [];
    for (const t of types) {
      keepIds.push(t.id);
      // The typed mirror columns are bind-sanitized so a hand-edited/legacy
      // record with a malformed timestamp can't make the INSERT throw and abort
      // the whole slice write (which runs during boot warm). `data` is verbatim.
      const updatedAt = mirrorTimestamp(t.updatedAt, null);
      const deletedAt = mirrorTimestamp(t.deletedAt, null);
      await exec(
        `INSERT INTO catalog_user_types (id, data, updated_at, deleted_at)
         VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()), $4)
         ON CONFLICT (id) DO UPDATE SET
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at,
           deleted_at = EXCLUDED.deleted_at`,
        [t.id, JSON.stringify(t), updatedAt, deletedAt],
      );
    }
    // Prune rows that left the desired slice. With keepIds empty the whole
    // table clears; otherwise delete everything NOT in the list.
    if (keepIds.length === 0) {
      await exec(`DELETE FROM catalog_user_types`);
    } else {
      await exec(`DELETE FROM catalog_user_types WHERE id <> ALL($1::text[])`, [keepIds]);
    }
  });
}
