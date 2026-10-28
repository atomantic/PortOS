/**
 * Unlock the catalog records that adding them to a universe's canon locked.
 *
 * `addPrimitiveToUniverse` copied a record's payload into a new canon entry
 * without a `locked` bit. A universe reads an entry with no bit as locked (its
 * default-lock contract), persisted `locked: true` on that write, and the
 * canon→catalog projection wrote the lock back onto the record. A record the
 * user created and only added to a universe therefore came out locked, which
 * also refused its reference-sheet preview and render.
 *
 * A record is selected only when ALL of these hold, so a deliberate lock is
 * never removed:
 *   - it is a live character/place/object whose payload is `locked: true`, and
 *     no active merge or shared-identity operation involves it;
 *   - its revision history shows the bug's signature: the first revision with
 *     `locked: true` is a canon projection (`source 'sync'`, actor
 *     `canon-projection`), the revision just before it has no `locked` key at
 *     all, and no later revision changed the bit (a user who unlocked and
 *     re-locked it is left alone). A pruned history fails this and is skipped;
 *   - every live universe canon entry pointing at it was minted by that add
 *     (`<type>-<uuid v4>` ids; universe-authored entries use other prefixes),
 *     and there is at least one.
 *
 * Writes mirror a user unlock: the record's bit becomes `false` with a revision,
 * and each of those canon entries gets `locked: false` stamped with the
 * record's new clock so the two stores agree under LWW. The universe's own
 * clock advances so the change reaches sync peers; the evidence (revision
 * history) is local to the install where the add happened, so peers cannot
 * derive it themselves. A re-run finds nothing: the records are unlocked.
 */

import { randomUUID } from 'node:crypto';
import { toPgJson } from '../../lib/pgJson.js';

const ACTOR = 'migration:022-unlock-canon-joined-records';
const FIELD = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });
const ADDED_ENTRY_ID = /^(character|place|object)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SELECT_CANDIDATES = `
  WITH candidates AS (
    SELECT i.id, i.type FROM catalog_ingredients i
    WHERE i.deleted = false
      AND i.type IN ('character', 'place', 'object')
      AND i.payload->'locked' = 'true'::jsonb
      AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_merges m
        WHERE m.restored_at IS NULL AND i.id IN (m.source_id, m.survivor_id))
      AND NOT EXISTS (SELECT 1 FROM catalog_identity_operations o
        WHERE o.state IN ('proposed', 'prepared', 'committed', 'recovery_prepared') AND i.id IN (o.source_id, o.survivor_id))
  ),
  revs AS (
    SELECT r.ingredient_id, r.source, r.actor, r.payload,
      row_number() OVER (PARTITION BY r.ingredient_id ORDER BY r.created_at, r.id) AS n
    FROM catalog_ingredient_revisions r JOIN candidates c ON c.id = r.ingredient_id
  ),
  first_lock AS (
    SELECT ingredient_id, min(n) AS n FROM revs WHERE payload->'locked' = 'true'::jsonb GROUP BY ingredient_id
  )
  SELECT c.id, c.type FROM candidates c
  JOIN first_lock f ON f.ingredient_id = c.id
  JOIN revs locking ON locking.ingredient_id = c.id AND locking.n = f.n
  JOIN revs prior ON prior.ingredient_id = c.id AND prior.n = f.n - 1
  WHERE locking.source = 'sync' AND locking.actor = 'canon-projection'
    AND NOT (prior.payload ? 'locked')
    AND NOT EXISTS (SELECT 1 FROM revs later
      WHERE later.ingredient_id = c.id AND later.n > f.n AND later.payload->'locked' IS DISTINCT FROM 'true'::jsonb)`;

// ingredientId → { added: [{ universeId, field, index }], other: count } over live universes.
function canonEntriesFor(universes, candidates) {
  const found = new Map([...candidates.keys()].map((id) => [id, { added: [], other: 0 }]));
  for (const universe of universes) {
    for (const [type, field] of Object.entries(FIELD)) {
      const list = Array.isArray(universe.data?.[field]) ? universe.data[field] : [];
      list.forEach((entry, index) => {
        const slot = found.get(entry?.ingredientId);
        if (!slot) return;
        if (candidates.get(entry.ingredientId) === type && ADDED_ENTRY_ID.test(entry.id) && entry.id.startsWith(`${type}-`)) {
          slot.added.push({ universeId: universe.id, field, index });
        } else slot.other += 1;
      });
    }
  }
  return found;
}

export async function up(client) {
  const { rows } = await client.query(SELECT_CANDIDATES);
  if (!rows.length) {
    console.log('🔓 canon-joined record unlock: no records match');
    return;
  }
  const candidates = new Map(rows.map((row) => [row.id, row.type]));
  const { rows: universes } = await client.query('SELECT id, data FROM universes WHERE deleted = false');
  const entries = canonEntriesFor(universes, candidates);
  const edits = new Map();
  let unlocked = 0;
  for (const [ingredientId, { added, other }] of entries) {
    if (!added.length || other) continue;
    const { rows: [record] } = await client.query(
      `UPDATE catalog_ingredients SET payload = jsonb_set(payload, '{locked}', 'false'::jsonb)
       WHERE id = $1 AND deleted = false AND payload->'locked' = 'true'::jsonb
       RETURNING id, name, payload, tags, updated_at`, [ingredientId]);
    if (!record) continue;
    await client.query(
      `INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload, tags, source, actor)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'sync', $6)`,
      [`cat-rev-${randomUUID()}`, record.id, record.name, toPgJson(record.payload), record.tags || [], ACTOR]);
    const clock = new Date(record.updated_at).toISOString();
    for (const { universeId, field, index } of added) {
      const universe = edits.get(universeId) || structuredClone(universes.find((u) => u.id === universeId).data);
      universe[field][index] = { ...universe[field][index], locked: false, updatedAt: clock };
      edits.set(universeId, universe);
    }
    unlocked += 1;
  }
  const now = new Date().toISOString();
  for (const [universeId, data] of edits) {
    await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1 AND deleted = false',
      [universeId, toPgJson({ ...data, updatedAt: now }), now]);
  }
  console.log(`🔓 canon-joined record unlock: unlocked ${unlocked} of ${rows.length} locked record${rows.length === 1 ? '' : 's'} with the canon-join signature across ${edits.size} universe${edits.size === 1 ? '' : 's'}`);
}
