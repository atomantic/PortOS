// AI provider connection graph DDL — `ai_connections`, `ai_harness_bindings`
// and `ai_route_bindings` (#6367, design record
// docs/plans/2026-09-06-provider-connections-and-harnesses.md).
//
// The MANAGEMENT half of provider configuration: which backend a harness talks
// to, which harness configurations exist on it, and which executable route each
// one projects into `data/providers.json`. The provider file stays the
// EXECUTION contract — every connection-owned value is materialized back into
// it — so a downgraded install runs unchanged with these tables simply idle.
//
// Machine-local by construction and never federated: rows carry endpoints,
// credential material and this host's execution environment, which the privacy
// ADR (docs/decisions/2026-08-08-privacy-records-machine-local.md) keeps off the
// federation layer entirely. No `sync_sequence`, no tombstones, no
// PORTOS_SCHEMA_VERSIONS entry. Hard deletes, refused by the service while a
// row is still referenced.
//
// Ordering inside this array is load-bearing: `ai_harness_bindings` references
// `ai_connections`, and `ai_route_bindings` references `ai_harness_bindings`.

export const aiGraphDdl = [
  // The backend a harness talks to. `credentials` is raw server-side secret
  // material under the same private boundary as provider secrets — it is never
  // published, logged, or federated; DTOs carry a `hasCredentials` boolean.
  `CREATE TABLE IF NOT EXISTS ai_connections (
      id UUID PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      transports JSONB NOT NULL DEFAULT '{}'::jsonb,
      credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
      catalog JSONB NOT NULL DEFAULT '{"state":"unknown","models":[]}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

  // One harness configuration on one connection. `harness_id` is NULL only for
  // a direct API binding, which is why the uniqueness below needs two partial
  // indexes rather than one constraint: in Postgres a NULL never equals another
  // NULL, so a plain UNIQUE(connection_id, harness_id, variant_key) would let
  // unlimited duplicate `default` API bindings onto one connection.
  `CREATE TABLE IF NOT EXISTS ai_harness_bindings (
      id UUID PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 1,
      connection_id UUID NOT NULL REFERENCES ai_connections (id),
      harness_id TEXT,
      variant_key TEXT NOT NULL DEFAULT 'default',
      label TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT false,
      selected_models JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_harness_bindings_variant
      ON ai_harness_bindings (connection_id, harness_id, variant_key)
      WHERE harness_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_harness_bindings_api_variant
      ON ai_harness_bindings (connection_id, variant_key)
      WHERE harness_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ai_harness_bindings_connection
      ON ai_harness_bindings (connection_id)`,

  // The executable route. `provider_id` is the PRIMARY KEY because it IS the
  // saved-selection contract every scheduled task, CoS pin, orchestration role
  // and fallback reference already stores — route ids are never reused.
  //
  // `projected` is the connection-owned snapshot last acknowledged as present
  // in providers.json; `pending` is one committed to the DB but not yet
  // acknowledged. A crash between the two is recoverable precisely because both
  // are kept: reconciliation compares the file's ACTUAL values against both
  // before deciding to retry, acknowledge, or refuse to overwrite a third,
  // externally changed value. Both snapshots can carry secrets, so they are as
  // private as `ai_connections.credentials`.
  `CREATE TABLE IF NOT EXISTS ai_route_bindings (
      provider_id TEXT PRIMARY KEY,
      binding_id UUID NOT NULL REFERENCES ai_harness_bindings (id),
      mode TEXT NOT NULL CHECK (mode IN ('cli', 'tui', 'api')),
      model_map JSONB NOT NULL DEFAULT '{}'::jsonb,
      projected JSONB NOT NULL DEFAULT '{}'::jsonb,
      pending JSONB,
      pending_revision INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  // Hand-authored canonical→executable aliases, kept apart from `model_map`
  // on purpose (#6369): a refresh rewrites what it OBSERVED, and merging the
  // two into one column would make the next refresh silently delete the
  // correction a human typed. Read as `{ ...model_map, ...overrides }`.
  `ALTER TABLE ai_route_bindings ADD COLUMN IF NOT EXISTS model_alias_overrides JSONB NOT NULL DEFAULT '{}'::jsonb`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_route_bindings_binding_mode
      ON ai_route_bindings (binding_id, mode)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_route_bindings_binding
      ON ai_route_bindings (binding_id)`,
];
