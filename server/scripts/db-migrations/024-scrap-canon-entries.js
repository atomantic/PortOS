/**
 * Repair live canon refs missing their embedded universe entry (scrap commits).
 * Input-gated, deterministic and idempotent; removed refs, deleted records,
 * forks and identities in transition remain untouched. Frozen migration 023
 * projection, with the live canon ref as input rather than a create-time owner.
 */
import { createHash } from 'node:crypto';
import { toPgJson } from '../../lib/pgJson.js';

const FIELD = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });
const ENTRIES_PER_BUCKET_MAX = 200;

const SELECT_UNJOINED = `
  SELECT i.id, i.type, i.name, i.payload, i.updated_at, o.ref_id AS universe_id
  FROM catalog_ingredients i
  JOIN catalog_ingredient_refs o ON o.ingredient_id = i.id AND o.ref_kind = 'universe' AND o.role = 'canon-' || i.type AND o.deleted = false
  JOIN universes u ON u.id = o.ref_id AND u.deleted = false
  WHERE i.deleted = false
    AND i.type IN ('character', 'place', 'object')
    AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_relations f WHERE f.from_id = i.id AND f.kind = 'forked-from')
    AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_merges m
      WHERE m.restored_at IS NULL AND i.id IN (m.source_id, m.survivor_id))
    AND NOT EXISTS (SELECT 1 FROM catalog_identity_operations x
      WHERE x.state IN ('proposed', 'prepared', 'committed', 'recovery_prepared') AND i.id IN (x.source_id, x.survivor_id))
  ORDER BY i.created_at, i.id`;

// Same `<type>-<uuid>` shape the live join mints, derived so peers agree.
export function canonEntryId(type, ingredientId, universeId) {
  const h = createHash('sha256').update(`${universeId}\u0000${ingredientId}`).digest('hex');
  const variant = '89ab'[parseInt(h[16], 16) & 3];
  return `${type}-${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function canonEntry(record) {
  const payload = structuredClone(record.payload && typeof record.payload === 'object' ? record.payload : {});
  for (const key of ['id', 'ingredientId', 'createdAt', 'updatedAt']) delete payload[key];
  return {
    ...payload,
    locked: payload.locked === true,
    id: canonEntryId(record.type, record.id, record.universe_id),
    ingredientId: record.id,
    name: record.name,
    updatedAt: new Date(record.updated_at).toISOString(),
  };
}

export async function up(client) {
  const { rows } = await client.query(SELECT_UNJOINED);
  if (!rows.length) {
    console.log('🎭 universe canon backfill: no owned records are missing their canon membership');
    return;
  }
  const universeIds = [...new Set(rows.map((row) => row.universe_id))];
  const { rows: universes } = await client.query('SELECT id, data, updated_at FROM universes WHERE id = ANY($1) AND deleted = false ORDER BY id FOR UPDATE', [universeIds]);
  const data = new Map(universes.map((u) => [u.id, structuredClone(u.data && typeof u.data === 'object' ? u.data : {})]));
  const changed = new Set();
  let joined = 0;
  let skipped = 0;
  for (const record of rows) {
    const universe = data.get(record.universe_id);
    const field = FIELD[record.type];
    const list = universe && Array.isArray(universe[field]) ? universe[field] : [];
    const entry = universe ? canonEntry(record) : null;
    if (!entry || list.some((e) => e?.ingredientId === record.id || e?.id === entry.id) || list.length >= ENTRIES_PER_BUCKET_MAX) {
      skipped += 1;
      continue;
    }
    universe[field] = [...list, entry];
    changed.add(record.universe_id);
    joined += 1;
  }
  for (const universeId of changed) {
    const universe = data.get(universeId);
    const before = universes.find((row) => row.id === universeId);
    const previousClocks = [before.updated_at?.getTime(), Date.parse(universe.updatedAt)].filter(Number.isFinite);
    const now = new Date(Math.max(Date.now(), ...previousClocks.map((clock) => clock + 1))).toISOString();
    await client.query('UPDATE universes SET data = $2::jsonb, updated_at = $3 WHERE id = $1 AND deleted = false',
      [universeId, toPgJson({ ...universe, updatedAt: now }), now]);
  }
  console.log(`🎭 universe canon backfill: joined ${joined} owned record${joined === 1 ? '' : 's'} to ${changed.size} universe${changed.size === 1 ? '' : 's'}, skipped ${skipped}`);
}
