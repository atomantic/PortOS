// Read-only views retain owner-reviewed evidence without rewriting foreign rows.
// Source snapshots remain authoritative. A survivor's live rows (including
// tombstones) take precedence over its retained pre-consolidation evidence.
const ASSOCIATIONS = {
  sources: ['catalog_ingredient_sources', ['ingredient_id', 'scrap_id']],
  refs: ['catalog_ingredient_refs', ['ingredient_id', 'ref_kind', 'ref_id', 'role']],
  media: ['catalog_ingredient_media', ['ingredient_id', 'media_key', 'kind']],
  relations: ['catalog_ingredient_relations', ['from_id', 'to_id', 'kind']],
  revisions: ['catalog_ingredient_revisions', ['id']],
};

export const catalogIdentityViewsDdl = () => Object.entries(ASSOCIATIONS).map(([kind, [table, keys]]) => {
  const sourceMatch = kind === 'relations'
    ? '(live.from_id = o.source_id OR live.to_id = o.source_id)'
    : 'live.ingredient_id = o.source_id';
  const remoteSurvivorMatch = kind === 'relations'
    ? '(live.from_id = o.survivor_id OR live.to_id = o.survivor_id)'
    : 'live.ingredient_id = o.survivor_id';
  const keySql = keys.map(key => `(r).${key}`).join(', ');
  const localAliasFilter = kind === 'relations'
    ? 'AND live.from_id = catalog_resolve_ingredient_id(live.from_id) AND live.to_id = catalog_resolve_ingredient_id(live.to_id)'
    : ['refs', 'media'].includes(kind) ? 'AND live.ingredient_id = catalog_resolve_ingredient_id(live.ingredient_id)' : '';
  return `CREATE OR REPLACE VIEW catalog_identity_read_${kind} AS
    WITH active AS (SELECT * FROM catalog_identity_operations WHERE state IN ('committed', 'recovery_prepared')),
    candidates AS (
      SELECT jsonb_populate_record(NULL::${table}, item) AS r, 0 AS priority
        FROM active o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.plan->'source'->'${kind}', '[]'::jsonb)) item
      UNION ALL
      SELECT live AS r, 1 AS priority FROM ${table} live
        WHERE NOT EXISTS (SELECT 1 FROM active o WHERE ${sourceMatch}
          OR (o.local_owner <> o.survivor_owner AND ${remoteSurvivorMatch}))
        ${localAliasFilter}
      UNION ALL
      SELECT jsonb_populate_record(NULL::${table}, item) AS r, 2 AS priority
        FROM active o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.current_snapshot->'${kind}', o.plan->'survivor'->'${kind}', '[]'::jsonb)) item
        ${kind === 'revisions' ? '' : 'WHERE o.local_owner <> o.survivor_owner'}
      ${kind === 'revisions' ? `UNION ALL
      SELECT jsonb_populate_record(NULL::${table}, item) AS r, 3 AS priority
        FROM active o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.plan->'survivor'->'revisions', '[]'::jsonb)) item` : ''}
      ${kind === 'media' ? `UNION ALL
      SELECT jsonb_populate_record(NULL::${table}, item) AS r, 4 AS priority
        FROM active o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.plan->'archivedMedia', '[]'::jsonb)) item` : ''}
    ) SELECT DISTINCT ON (${keySql}) (r).*, priority IN (0, 3, 4) AS identity_retained
      FROM candidates ORDER BY ${keySql}, priority`;
});
