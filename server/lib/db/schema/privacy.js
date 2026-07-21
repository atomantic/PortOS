// Privacy-suite DDL — vault records, consents, orgs, org holdings, brokers,
// broker cases, and change events. Extracted verbatim from ensureSchemaImpl()
// in server/lib/db.js (#2832); idempotent, runs on every boot.
export const privacyDdl = [
    // ─── Privacy Center: PII Vault (issue #2140, epic #2138) ─────────────────
    // Encrypted-at-rest identity facts. `value_enc` is AES-256-GCM ciphertext
    // (`v1:<iv>:<tag>:<ct>`, key from PRIVACY_VAULT_KEY — lib/vaultCrypto.js);
    // plaintext is NEVER stored, `masked_value` is the display form. Machine-
    // local: no federation, no tombstones (deferred, #2148) — a delete is a
    // hard DELETE. `use_for_scans` gates which facts the broker scan engine
    // may disclose (hard-false for ssn/passport/drivers_license/
    // financial_account — enforced app-side). Mirrors the privacy blocks in
    // init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_vault_records (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      value_enc TEXT NOT NULL,
      masked_value TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'current',
      valid_from DATE,
      valid_to DATE,
      share_with_twin BOOLEAN NOT NULL DEFAULT FALSE,
      use_for_scans BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Type is the primary list filter (all addresses, all emails, ...).
    `CREATE INDEX IF NOT EXISTS idx_privacy_vault_records_type ON privacy_vault_records (type)`,
    // Explicit consent audit rows (v1 subject is always 'self'); the broker
    // opt-out engine builds on this trail. Append-only.
    `CREATE TABLE IF NOT EXISTS privacy_consents (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT 'self',
      scope TEXT NOT NULL,
      method TEXT NOT NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ─── Privacy Center: Trusted Organizations registry (issue #2141, epic
    // #2138) ──────────────────────────────────────────────────────────────
    // Every organization that has (or had) the user's PII, with a trust
    // stance and per-org holdings linking to the exact vault records each org
    // holds. Data backbone for the change-of-address inventory (Phase 4) and
    // the "who has my PII" view. Machine-local: no federation, no tombstones
    // (same deferred scope as the vault, #2148). Mirrors the privacy blocks
    // in init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_orgs (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      website TEXT NOT NULL DEFAULT '',
      trust TEXT NOT NULL DEFAULT 'trusted',
      status TEXT NOT NULL DEFAULT 'active',
      contact JSONB NOT NULL DEFAULT '{}'::jsonb,
      social_account_id TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_orgs_trust ON privacy_orgs (trust)`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_orgs_status ON privacy_orgs (status)`,
    // Which vault records each org holds. Composite PK (no surrogate id) — an
    // org either holds a given vault record or it doesn't, so the pair IS the
    // identity. Cascade both ways: deleting the org or the vault record drops
    // its holdings rows.
    `CREATE TABLE IF NOT EXISTS privacy_org_holdings (
      org_id UUID NOT NULL REFERENCES privacy_orgs (id) ON DELETE CASCADE,
      vault_record_id UUID NOT NULL REFERENCES privacy_vault_records (id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'current',
      noted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (org_id, vault_record_id)
    )`,
    // Reverse lookup: "which orgs hold vault record X" (getOrgsHoldingRecord).
    `CREATE INDEX IF NOT EXISTS idx_privacy_org_holdings_vault_record ON privacy_org_holdings (vault_record_id)`,

    // ─── Privacy Center: data-broker database + case ledger (issue #2144,
    // epic #2138) ──────────────────────────────────────────────────────────
    // `privacy_brokers` is the curated (+ later BADBOOL / CA-registry) database
    // of people-search brokers the exposure-scan/opt-out engine works. Seeded
    // idempotently from data.reference/privacy/brokers.json on first use (NO
    // network at boot). `source`/`confidence` gate the refresh: curated rows
    // (field_verified/documented) are never clobbered by an auto refresh.
    // `cluster_parent` groups sibling brands under one suppression;
    // `disclosure_fields` caps what the engine may ever submit to that broker.
    // Machine-local — no federation, no tombstones (same deferred scope as the
    // vault, #2148). Mirrors the privacy blocks in init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_brokers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      urls JSONB NOT NULL DEFAULT '{}'::jsonb,
      optout JSONB NOT NULL DEFAULT '{}'::jsonb,
      tier SMALLINT NOT NULL DEFAULT 2,
      disclosure_fields TEXT[] NOT NULL DEFAULT '{}',
      cluster_parent TEXT REFERENCES privacy_brokers (id) ON DELETE SET NULL,
      prefer_suppression BOOLEAN NOT NULL DEFAULT FALSE,
      antibot BOOLEAN NOT NULL DEFAULT FALSE,
      source TEXT NOT NULL DEFAULT 'curated',
      confidence TEXT NOT NULL DEFAULT 'documented',
      last_verified DATE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Planner walks enabled brokers, cluster-parents first.
    `CREATE INDEX IF NOT EXISTS idx_privacy_brokers_enabled ON privacy_brokers (enabled)`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_brokers_cluster_parent ON privacy_brokers (cluster_parent)`,
    // Per-broker exposure/opt-out case ledger with a service-enforced state
    // machine. `state` is validated app-side (privacyBrokers.js); every write
    // stamps `next_recheck_at` (state-dependent backoff). `evidence` holds
    // listing URLs / match basis / screenshot refs — NOT plaintext PII (the
    // engine records only least-disclosure identifiers). A broker delete
    // cascades its cases.
    `CREATE TABLE IF NOT EXISTS privacy_broker_cases (
      id UUID PRIMARY KEY,
      broker_id TEXT NOT NULL REFERENCES privacy_brokers (id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'unscanned',
      found BOOLEAN,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      disclosed_fields TEXT[] NOT NULL DEFAULT '{}',
      channel TEXT,
      reason TEXT,
      next_recheck_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // One live case per broker in v1 (self-only subject) — unique so the
    // scan-pass upsert can ON CONFLICT the broker id.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_broker_cases_broker ON privacy_broker_cases (broker_id)`,
    // "Which cases are due for a recheck" — the run-loop's primary query.
    `CREATE INDEX IF NOT EXISTS idx_privacy_broker_cases_recheck ON privacy_broker_cases (next_recheck_at)`,

    // ─── Privacy Center: change-of-address events (issue #2143, epic #2138) ──
    // One row per "field X changed from A to B" declaration. `vault_record_id`
    // is the OLD record (marked `previous` on declare); `replacement_record_id`
    // is the NEW one (nullable for a removal-only change). Declaring an event
    // flips every `current` holding of the old record to `update_pending` (see
    // privacyChanges.js). Both FKs cascade so removing a vault record cleans up
    // its change events. Machine-local — no federation, no tombstones (same
    // deferred scope as the vault, #2148). Mirrors the block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_change_events (
      id UUID PRIMARY KEY,
      vault_record_id UUID NOT NULL REFERENCES privacy_vault_records (id) ON DELETE CASCADE,
      replacement_record_id UUID REFERENCES privacy_vault_records (id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      declared_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT NOT NULL DEFAULT ''
    )`,
    // "Changes touching this record" — the inventory groups by the old record.
    `CREATE INDEX IF NOT EXISTS idx_privacy_change_events_vault_record ON privacy_change_events (vault_record_id)`,

];
