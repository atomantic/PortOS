/**
 * Forks made before forks joined canon were only owned by their universe, so
 * their record page reported "No writable canon binding" and the character's
 * story, voice and sheet tools had no canon entry to edit. Add each such fork
 * to its owning universe's canon: one canon entry built from the record (a
 * frozen copy of catalogPrimitives.canonEntryFor) plus its canon ref. A fork
 * whose canon ref was ever written (even if later removed) is left alone, so a
 * deliberate removal is not undone. No provider calls.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../server/lib/db.js';
import { BIBLE_LIMITS, SANITIZERS } from '../../server/lib/storyBible.js';

const FIELD = { character: 'characters', place: 'places', object: 'objects' };

const CANDIDATES = `SELECT DISTINCT i.id, i.type, owner.ref_id AS "universeId"
  FROM catalog_ingredient_relations rel
  JOIN catalog_ingredients i ON i.id = rel.from_id AND i.deleted = false
  JOIN catalog_ingredient_refs owner ON owner.ingredient_id = i.id AND owner.ref_kind = 'universe'
    AND owner.role = 'owner' AND owner.deleted = false
  JOIN universes u ON u.id = owner.ref_id AND u.deleted = false
  WHERE rel.kind = 'forked-from' AND rel.deleted = false AND i.type IN ('character', 'place', 'object')
    AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_refs canon WHERE canon.ingredient_id = i.id
      AND canon.ref_kind = 'universe' AND canon.ref_id = owner.ref_id AND canon.role = 'canon-' || i.type)`;

// Returns true when the fork was added (or already had an entry and only needed its ref).
async function repair({ id, type, universeId }) {
  return withTransaction(async (client) => {
    const role = `canon-${type}`;
    const { rows: [universeRow] } = await client.query('SELECT data, deleted FROM universes WHERE id = $1 FOR UPDATE', [universeId]);
    const { rows: [record] } = await client.query('SELECT id, name, payload FROM catalog_ingredients WHERE id = $1 AND deleted = false FOR UPDATE', [id]);
    const universe = universeRow?.data;
    if (!universe || universeRow.deleted || universe.deleted || !record) return false;
    const { rows: existingRef } = await client.query(`SELECT 1 FROM catalog_ingredient_refs
      WHERE ingredient_id = $1 AND ref_kind = 'universe' AND ref_id = $2 AND role = $3`, [id, universeId, role]);
    if (existingRef.length) return false;
    const field = FIELD[type];
    const list = Array.isArray(universe[field]) ? universe[field] : [];
    if (!list.some((entry) => entry?.ingredientId === id)) {
      if (list.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) throw new Error(`${universeId} ${field} is full`);
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(universe.updatedAt) || 0) + 1)).toISOString();
      const payload = structuredClone(record.payload || {});
      for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt']) delete payload[key];
      const entry = SANITIZERS[type]({ ...payload, locked: payload.locked === true, id: `${type}-${randomUUID()}`,
        ingredientId: id, name: record.name, updatedAt });
      if (!entry) throw new Error(`${id} has no valid canon entry`);
      const next = { ...universe, [field]: [...list, entry], updatedAt };
      await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1', [universeId, JSON.stringify(next), updatedAt]);
    }
    await client.query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
      VALUES ($1, 'universe', $2, $3) ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO NOTHING`, [id, universeId, role]);
    return true;
  });
}

export default {
  async up() {
    const { rows } = await query(CANDIDATES);
    let repaired = 0;
    let failed = 0;
    for (const row of rows) {
      // One unrepairable fork (e.g. a full canon bucket) must not block the rest.
      await repair(row).then((done) => { if (done) repaired += 1; }, (error) => {
        failed += 1;
        console.warn(`⚠️ migration 452: fork ${row.id} not added to canon: ${error.message}`);
      });
    }
    if (rows.length) console.log(`🧬 migration 452: fork canon membership repaired=${repaired} failed=${failed}`);
    return { repaired, failed };
  },
};
