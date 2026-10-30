/**
 * Forks made before forks joined canon were only owned by their universe, so
 * their record page reported "No writable canon binding" and the character's
 * story, voice and sheet actions had no canon entry to edit. Add each such fork
 * to its owning universe's canon through the same service a user's "add to
 * canon" uses. A fork whose canon link was ever written (even if later removed)
 * is left alone, so a deliberate removal is not undone. No provider calls.
 */
import { query } from '../../server/lib/db.js';

export default {
  async up() {
    const { rows } = await query(`SELECT DISTINCT i.id, i.type, owner.ref_id AS "universeId"
      FROM catalog_ingredient_relations rel
      JOIN catalog_ingredients i ON i.id = rel.from_id AND i.deleted = false
      JOIN catalog_ingredient_refs owner ON owner.ingredient_id = i.id AND owner.ref_kind = 'universe'
        AND owner.role = 'owner' AND owner.deleted = false
      JOIN universes u ON u.id = owner.ref_id AND u.deleted = false
      WHERE rel.kind = 'forked-from' AND rel.deleted = false AND i.type IN ('character', 'place', 'object')
        AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_refs canon WHERE canon.ingredient_id = i.id
          AND canon.ref_kind = 'universe' AND canon.ref_id = owner.ref_id AND canon.role = 'canon-' || i.type)`);
    if (!rows.length) return { repaired: 0, failed: 0 };
    const { addPrimitiveToUniverse } = await import('../../server/services/catalogPrimitives.js');
    let repaired = 0;
    let failed = 0;
    for (const row of rows) {
      // One unrepairable fork (e.g. a full canon bucket) must not block the rest.
      await addPrimitiveToUniverse(row.id, row.universeId, `canon-${row.type}`).then(() => { repaired += 1; }, (error) => {
        failed += 1;
        console.warn(`⚠️ migration 452: fork ${row.id} not added to canon: ${error.message}`);
      });
    }
    console.log(`🧬 migration 452: fork canon membership repaired=${repaired} failed=${failed}`);
    return { repaired, failed };
  },
};
