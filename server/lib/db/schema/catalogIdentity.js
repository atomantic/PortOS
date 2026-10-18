// Bilateral receipts are local protocol state, not ordinary LWW catalog rows.
export const catalogIdentityDdl = [
  `CREATE TABLE IF NOT EXISTS catalog_identity_operations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES catalog_ingredients(id),
    survivor_id TEXT NOT NULL REFERENCES catalog_ingredients(id),
    source_owner TEXT NOT NULL,
    survivor_owner TEXT NOT NULL,
    local_owner TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed', 'prepared', 'committed', 'aborted', 'recovery_prepared', 'recovered')),
    epoch INTEGER NOT NULL DEFAULT 0,
    plan JSONB NOT NULL,
    plan_hash TEXT NOT NULL,
    before_state JSONB,
    applied_fingerprint TEXT,
    current_snapshot JSONB,
    recovery JSONB,
    peer_state TEXT,
    peer_observed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (source_id <> survivor_id),
    CHECK (source_owner <> survivor_owner),
    CHECK (local_owner IN (source_owner, survivor_owner))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_identity_source ON catalog_identity_operations(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_identity_survivor ON catalog_identity_operations(survivor_id)`,
  `CREATE OR REPLACE FUNCTION catalog_canonical_ingredient_id(requested_id TEXT)
    RETURNS TEXT LANGUAGE SQL STABLE AS $$
    SELECT catalog_resolve_ingredient_id(COALESCE((SELECT survivor_id FROM catalog_identity_operations
      WHERE source_id = requested_id AND state IN ('committed', 'recovery_prepared')), requested_id))
    $$`,
  `CREATE OR REPLACE FUNCTION catalog_identity_member_ids(requested_id TEXT)
    RETURNS TEXT[] LANGUAGE SQL STABLE AS $$
    SELECT ARRAY(SELECT DISTINCT member FROM (
      SELECT catalog_canonical_ingredient_id(requested_id) AS member
      UNION ALL SELECT source_id FROM catalog_identity_operations
        WHERE survivor_id = catalog_canonical_ingredient_id(requested_id) AND state IN ('committed', 'recovery_prepared')
      UNION ALL SELECT source_id FROM catalog_ingredient_merges
        WHERE survivor_id = catalog_canonical_ingredient_id(requested_id) AND restored_at IS NULL
    ) members)
    $$`,
  `CREATE OR REPLACE FUNCTION guard_catalog_identity_member()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE touched TEXT[]; old_row JSONB; new_row JSONB; operation RECORD;
    BEGIN
      IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
      IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
      touched := ARRAY[old_row->>'id', new_row->>'id', old_row->>'ingredient_id', new_row->>'ingredient_id',
        old_row->>'from_id', new_row->>'from_id', old_row->>'to_id', new_row->>'to_id'];
      FOR operation IN SELECT * FROM catalog_identity_operations
        WHERE state IN ('prepared', 'committed', 'recovery_prepared')
          AND (source_id = ANY(touched) OR survivor_id = ANY(touched)) LOOP
        IF current_setting('portos.catalog_identity_operation', true) IS DISTINCT FROM operation.id THEN
          IF current_setting('portos.catalog_identity_peer_apply', true) = 'on'
            OR operation.state IN ('prepared', 'recovery_prepared') OR operation.source_id = ANY(touched)
            OR operation.local_owner <> operation.survivor_owner
            OR (TG_TABLE_NAME = 'catalog_ingredients' AND
              (TG_OP = 'DELETE' OR (new_row->>'deleted')::boolean OR new_row->>'origin_instance_id' IS DISTINCT FROM operation.survivor_owner
                OR new_row->>'type' IS DISTINCT FROM old_row->>'type')) THEN
            RAISE EXCEPTION 'Shared canonical identity is protected; use its owner protocol' USING ERRCODE = 'P0001';
          END IF;
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`,
  ...['catalog_ingredients', 'catalog_ingredient_sources', 'catalog_ingredient_refs', 'catalog_ingredient_media',
    'catalog_ingredient_relations', 'catalog_ingredient_revisions'].flatMap(table => [
    `DROP TRIGGER IF EXISTS trg_catalog_identity_member ON ${table}`,
    `CREATE TRIGGER trg_catalog_identity_member BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION guard_catalog_identity_member()`,
  ]),
];
