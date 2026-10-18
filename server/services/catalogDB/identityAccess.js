// Shared identity reads may resolve across owners; ordinary writes may not.
// Durable database fences enforce the same rule across the preflight/write gap.
import { query } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getInstanceId } from '../instanceIdentity.js';

export async function getCatalogIdentityAccess(id, { client } = {}) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(`SELECT o.id, o.state, o.source_id, o.survivor_id,
      o.source_owner, o.survivor_owner, o.local_owner, i.origin_instance_id,
      catalog_resolve_ingredient_id($1) AS requested_id
    FROM catalog_identity_operations o
    LEFT JOIN catalog_ingredients i ON i.id = o.survivor_id
    WHERE (o.source_id = catalog_resolve_ingredient_id($1) OR o.survivor_id = catalog_resolve_ingredient_id($1))
      AND o.state IN ('prepared', 'committed', 'recovery_prepared')`, [id]);
  if (!rows.length) return null;
  const row = rows[0];
  const localId = await getInstanceId();
  const reason = rows.some(item => item.state !== 'committed') ? 'CATALOG_IDENTITY_FENCED'
    : rows.some(item => item.source_id === item.requested_id) ? 'CATALOG_IDENTITY_RETAINED'
      : rows.some(item => !item.origin_instance_id || item.origin_instance_id !== localId) ? 'CATALOG_IDENTITY_FOREIGN' : null;
  return { operationId: row.id, sourceId: row.source_id, survivorId: row.survivor_id,
    sourceOwner: row.source_owner, survivorOwner: row.survivor_owner, localOwner: row.local_owner,
    state: row.state, writable: reason === null, reason };
}

export async function assertCatalogIdentityWritable(id, options) {
  const access = await getCatalogIdentityAccess(id, options);
  if (!access || access.writable) return id;
  const messages = {
    CATALOG_IDENTITY_FENCED: 'This identity is awaiting coordinated completion or recovery',
    CATALOG_IDENTITY_RETAINED: 'This original is retained; select the canonical identity to edit',
    CATALOG_IDENTITY_FOREIGN: 'Edit this shared identity on its canonical owner',
  };
  throw new ServerError(messages[access.reason], { status: 409, code: access.reason });
}

// A retained association is visible evidence, not a mutable row on the survivor.
// Refuse instead of reporting success for a zero-row removal that would reappear.
export async function assertCatalogAssociationRemovable(id, kind, values) {
  const selectors = {
    media: ['catalog_ingredient_media', ['media_key', 'kind']],
    refs: ['catalog_ingredient_refs', ['ref_kind', 'ref_id', 'role']],
  };
  const [table, columns] = selectors[kind];
  const match = columns.map((column, i) => `retained.${column} = $${i + 2}`).join(' AND ');
  const ownMatch = columns.map(column => `live.${column} = retained.${column}`).join(' AND ');
  const { rows } = await query(`SELECT 1 FROM catalog_identity_operations o
    JOIN catalog_identity_read_${kind} retained ON retained.identity_retained = true
      AND retained.ingredient_id IN (o.source_id, o.survivor_id)
    WHERE o.survivor_id = catalog_canonical_ingredient_id($1)
      AND o.state IN ('committed', 'recovery_prepared') AND retained.deleted = false AND ${match}
      AND NOT EXISTS (SELECT 1 FROM ${table} live WHERE live.ingredient_id = o.survivor_id
        AND live.deleted = false AND ${ownMatch}) LIMIT 1`, [id, ...values]);
  if (rows.length) throw new ServerError('This association is retained original evidence and cannot be removed', {
    status: 409, code: 'CATALOG_IDENTITY_RETAINED',
  });
}

export async function assertCatalogRelationRemovable(fromId, toId, kind) {
  const { rows } = await query(`SELECT 1 FROM catalog_identity_read_relations retained
    JOIN catalog_identity_operations o ON (o.source_id = retained.from_id OR o.source_id = retained.to_id)
    WHERE o.state IN ('committed', 'recovery_prepared') AND retained.deleted = false
      AND catalog_canonical_ingredient_id(retained.from_id) = catalog_canonical_ingredient_id($1)
      AND catalog_canonical_ingredient_id(retained.to_id) = catalog_canonical_ingredient_id($2)
      AND retained.kind = $3 AND NOT EXISTS (SELECT 1 FROM catalog_ingredient_relations live
        WHERE live.from_id = catalog_resolve_ingredient_id($1) AND live.to_id = catalog_resolve_ingredient_id($2)
          AND live.kind = $3 AND live.deleted = false) LIMIT 1`, [fromId, toId, kind]);
  if (rows.length) throw new ServerError('This relation is retained original evidence and cannot be removed', {
    status: 409, code: 'CATALOG_IDENTITY_RETAINED',
  });
}
