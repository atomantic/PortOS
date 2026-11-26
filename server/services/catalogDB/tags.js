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
import { canonicalTagKey, tagIdForKey } from '../../lib/catalog/catalogTypes.js';
import { rowToTag } from './shared.js';

/**
 * Map a list of freeform tag labels to canonical labels, creating a
 * `catalog_tags` row per unique canonical key on first use. Returns the
 * de-duplicated, order-preserving list of canonical labels (first-seen casing
 * wins, both within this call and against any pre-existing row). Empty / blank
 * tags are dropped. `{ client }` runs the upserts on the caller's transaction.
 */
export async function normalizeTags(labels = [], { client } = {}) {
  const [normalized] = await normalizeTagLists([labels], { client });
  return normalized;
}

export async function normalizeTagLists(lists, { client } = {}) {
  const exec = client ? client.query.bind(client) : query;

  // Preserve each ingredient's tag order, with first-seen casing across the batch.
  const wanted = new Map();
  const idsByList = lists.map((labels) => {
    const ids = new Set();
    for (const raw of Array.isArray(labels) ? labels : []) {
      const key = canonicalTagKey(raw);
      if (!key) continue;
      const id = tagIdForKey(key);
      ids.add(id);
      if (!wanted.has(id)) wanted.set(id, String(raw).trim().replace(/\s+/g, ' '));
    }
    return [...ids];
  });
  if (wanted.size === 0) return idsByList;

  // Query 1 — read every pre-existing row in one round-trip. A stored label
  // always wins over the incoming casing (`Noir` beats a later `NOIR`).
  const existing = await exec(
    `SELECT id, label FROM catalog_tags WHERE id = ANY($1)`,
    [[...wanted.keys()]],
  );
  const canonical = new Map(existing.rows.map((r) => [r.id, r.label]));

  // Query 2 — create every missing canonical row in one multi-row insert.
  // ON CONFLICT DO NOTHING keeps first-write-wins; a row that conflicts here
  // was created between the two statements, so fall back to the incoming
  // label rather than spending another round-trip re-reading it.
  // Use one lock order for concurrent batches with overlapping new tags.
  const missing = [...wanted.keys()].filter((id) => !canonical.has(id)).sort();
  if (missing.length > 0) {
    const values = missing.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const ins = await exec(
      `INSERT INTO catalog_tags (id, label)
       VALUES ${values}
       ON CONFLICT (id) DO NOTHING
       RETURNING id, label`,
      missing.flatMap((id) => [id, wanted.get(id)]),
    );
    for (const row of ins.rows) canonical.set(row.id, row.label);
  }

  return idsByList.map((ids) => ids.map((id) => canonical.get(id) ?? wanted.get(id)));
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
