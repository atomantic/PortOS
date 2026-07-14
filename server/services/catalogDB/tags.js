/**
 * Creative Ingredients Catalog — tag taxonomy.
 *
 * `catalog_tags` is the canonical index over the freeform
 * `catalog_ingredients.tags TEXT[]` column. `normalizeTags` maps user input
 * through it (creating rows on first use, deterministic `cat-tag-<key>` ids)
 * and returns the de-duplicated canonical label list to store in the array
 * column. The freeform column keeps working unchanged for GIN tag-search.
 */

import { query } from '../../lib/db.js';
import { canonicalTagKey, tagIdForKey } from '../../lib/catalogTypes.js';
import { rowToTag } from './shared.js';

/**
 * Map a list of freeform tag labels to canonical labels, creating a
 * `catalog_tags` row per unique canonical key on first use. Returns the
 * de-duplicated, order-preserving list of canonical labels (first-seen casing
 * wins, both within this call and against any pre-existing row). Empty / blank
 * tags are dropped. `{ client }` runs the upserts on the caller's transaction.
 */
export async function normalizeTags(labels = [], { client } = {}) {
  if (!Array.isArray(labels) || labels.length === 0) return [];
  const exec = client ? client.query.bind(client) : query;
  const out = [];
  const seen = new Set();
  for (const raw of labels) {
    const key = canonicalTagKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const id = tagIdForKey(key);
    const label = String(raw).trim().replace(/\s+/g, ' ');
    // First write wins on the canonical label — ON CONFLICT DO NOTHING keeps
    // the original casing rather than letting a later `NOIR` overwrite `Noir`.
    // RETURNING after a no-op conflict is empty, so re-select to read the
    // stored canonical label for the array column.
    const ins = await exec(
      `INSERT INTO catalog_tags (id, label)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING label`,
      [id, label],
    );
    if (ins.rows[0]?.label) {
      out.push(ins.rows[0].label);
    } else {
      const existing = await exec(`SELECT label FROM catalog_tags WHERE id = $1`, [id]);
      out.push(existing.rows[0]?.label ?? label);
    }
  }
  return out;
}

export async function getTag(id) {
  const result = await query(`SELECT * FROM catalog_tags WHERE id = $1`, [id]);
  return rowToTag(result.rows[0]);
}

/**
 * Autocomplete / list canonical tags. `q` does a case-insensitive prefix-then-
 * substring match on label (prefix matches rank first); absent `q` returns the
 * most-recently-created tags. Drives the tag-picker autocomplete.
 */
export async function listTags({ q, limit = 20 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  if (q && String(q).trim()) {
    const term = String(q).trim();
    const result = await query(
      `SELECT * FROM catalog_tags
        WHERE label ILIKE $1
        ORDER BY
          CASE WHEN label ILIKE $2 THEN 0 ELSE 1 END,
          label ASC
        LIMIT $3`,
      [`%${term}%`, `${term}%`, lim],
    );
    return { items: result.rows.map(rowToTag) };
  }
  const result = await query(
    `SELECT * FROM catalog_tags ORDER BY created_at DESC LIMIT $1`,
    [lim],
  );
  return { items: result.rows.map(rowToTag) };
}

/**
 * Patch a tag's mutable fields (description / color / parent_id). `label` is
 * intentionally NOT patchable here — relabeling would orphan the freeform
 * array values that reference the old casing. Self-parent is rejected.
 */
export async function updateTag(id, patch = {}) {
  const fields = [];
  const params = [];
  let idx = 1;
  const fieldMap = { description: 'description', color: 'color', parentId: 'parent_id' };
  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (patch[jsField] === undefined) continue;
    if (jsField === 'parentId' && patch.parentId === id) {
      throw new Error('a tag cannot be its own parent');
    }
    fields.push(`${dbField} = $${idx++}`);
    params.push(patch[jsField] === '' ? null : patch[jsField]);
  }
  if (fields.length === 0) return getTag(id);
  params.push(id);
  const result = await query(
    `UPDATE catalog_tags SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rowToTag(result.rows[0]);
}
