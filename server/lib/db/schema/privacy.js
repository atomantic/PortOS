// Privacy-suite DDL — household subjects, vault records, consents, orgs, org
// holdings, brokers, broker cases, and change events. Extracted verbatim from
// ensureSchemaImpl() in server/lib/db.js (#2832); idempotent, runs on every boot.
//
// The seeded `self` subject. A FIXED uuid (not a random one) so the DDL below,
// server/scripts/init-db.sql, and server/lib/privacyValidation.js's
// SELF_SUBJECT_ID all name the same row on every install without a lookup.
// Mirrors PRIVACY_SELF_SUBJECT_ID in server/lib/privacyValidation.js — change
// both or neither.
const SELF_SUBJECT_ID = '00000000-0000-4000-8000-000000000001';

// The privacy tables that carry a `subject_id` scope column (issue #3658).
// Each gets: ADD COLUMN IF NOT EXISTS → backfill NULLs to `self` → SET DEFAULT
// → SET NOT NULL. All four steps are idempotent, so an existing install picks
// the column up at boot and a fresh install (where the CREATE TABLE body below
// already declares it) no-ops through them.
const SUBJECT_SCOPED_TABLES = [
    'privacy_vault_records',
    'privacy_orgs',
    'privacy_org_holdings',
    'privacy_change_events',
    'privacy_broker_cases',
    'privacy_consents',
];

const subjectScopeUpgrades = SUBJECT_SCOPED_TABLES.flatMap((table) => [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS subject_id UUID REFERENCES privacy_subjects (id) ON DELETE CASCADE`,
    `UPDATE ${table} SET subject_id = '${SELF_SUBJECT_ID}' WHERE subject_id IS NULL`,
    `ALTER TABLE ${table} ALTER COLUMN subject_id SET DEFAULT '${SELF_SUBJECT_ID}'`,
    `ALTER TABLE ${table} ALTER COLUMN subject_id SET NOT NULL`,
]);

export const privacyDdl = [
    // ─── Privacy Center: household subjects (issue #3658) ────────────────────
    // Every person the Privacy Center works on behalf of — `self` plus any
    // consenting household member (partner, child, parent). A TABLE rather than
    // a free-text `subject` string so renames aren't lossy and scoping stays
    // typed. Machine-local like the rest of the suite: no federation, no
    // tombstones, hard deletes (which CASCADE the subject's vault/org/holding/
    // change/case/consent rows). Created FIRST so the FKs below resolve.
    `CREATE TABLE IF NOT EXISTS privacy_subjects (
      id UUID PRIMARY KEY,
      display_name TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'other',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    // Seed the `self` row at a fixed id. Idempotent — an install that has
    // already renamed it keeps its own display_name.
    `INSERT INTO privacy_subjects (id, display_name, relationship, created_at, updated_at)
     VALUES ('${SELF_SUBJECT_ID}', 'Me', 'self', NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,

    // ─── Privacy Center: PII Vault (issue #2140, epic #2138) ─────────────────
    // Encrypted-at-rest identity facts. `value_enc` is AES-256-GCM ciphertext
    // (`v1:<iv>:<tag>:<ct>`, key from PRIVACY_VAULT_KEY — lib/vaultCrypto.js);
    // plaintext is NEVER stored, `masked_value` is the display form. Machine-
    // local: no federation, no tombstones — NEVER federated by decision, not
    // deferral (ADR docs/decisions/2026-08-08-privacy-records-machine-local.md,
    // #2148); adding a sync cursor here trips
    // services/sharing/privacyNeverFederates.test.js. A delete is a
    // hard DELETE. `use_for_scans` gates which facts the broker scan engine
    // may disclose (hard-false for ssn/passport/drivers_license/
    // financial_account — enforced app-side). Mirrors the privacy blocks in
    // init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_vault_records (
      id UUID PRIMARY KEY,
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
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
    // Explicit consent audit rows, one per subject; the broker opt-out engine
    // builds on this trail and REFUSES to act for a subject with no row here
    // (privacySubjects.assertSubjectConsent, #3658). Append-only. The legacy
    // free-text `subject` column is kept for the historical audit trail —
    // `subject_id` is the FK the engine and every query scope on.
    `CREATE TABLE IF NOT EXISTS privacy_consents (
      id UUID PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT 'self',
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      method TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      granted_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ─── Privacy Center: Trusted Organizations registry (issue #2141, epic
    // #2138) ──────────────────────────────────────────────────────────────
    // Every organization that has (or had) the user's PII, with a trust
    // stance and per-org holdings linking to the exact vault records each org
    // holds. Data backbone for the change-of-address inventory (Phase 4) and
    // the "who has my PII" view. Machine-local: no federation, no tombstones
    // — NEVER federated, same guarantee as the vault (ADR
    // docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148).
    // Mirrors the privacy blocks in init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_orgs (
      id UUID PRIMARY KEY,
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
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
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
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
    // Machine-local — no federation, no tombstones; NEVER federated, same
    // guarantee as the vault (ADR
    // docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148).
    // Mirrors the privacy blocks in init-db.sql.
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
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
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
    // One live case per (broker, subject) — two household members are worked
    // through the same broker independently, so the uniqueness that used to be
    // on `broker_id` alone is now on the pair (#3658). The single-column index
    // is dropped so an existing install can widen without a manual step; the
    // pair index is created by subjectScopeUpgrades below, AFTER `subject_id`
    // exists on the table.
    `DROP INDEX IF EXISTS idx_privacy_broker_cases_broker`,
    // "Which cases are due for a recheck" — the run-loop's primary query.
    `CREATE INDEX IF NOT EXISTS idx_privacy_broker_cases_recheck ON privacy_broker_cases (next_recheck_at)`,

    // ─── Privacy Center: change-of-address events (issue #2143, epic #2138) ──
    // One row per "field X changed from A to B" declaration. `vault_record_id`
    // is the OLD record (marked `previous` on declare); `replacement_record_id`
    // is the NEW one (nullable for a removal-only change). Declaring an event
    // flips every `current` holding of the old record to `update_pending` (see
    // privacyChanges.js). Both FKs cascade so removing a vault record cleans up
    // its change events. Machine-local — no federation, no tombstones; NEVER
    // federated, same guarantee as the vault (ADR
    // docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148).
    // Mirrors the block in init-db.sql.
    `CREATE TABLE IF NOT EXISTS privacy_change_events (
      id UUID PRIMARY KEY,
      subject_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES privacy_subjects (id) ON DELETE CASCADE,
      vault_record_id UUID NOT NULL REFERENCES privacy_vault_records (id) ON DELETE CASCADE,
      replacement_record_id UUID REFERENCES privacy_vault_records (id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      declared_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT NOT NULL DEFAULT ''
    )`,
    // "Changes touching this record" — the inventory groups by the old record.
    `CREATE INDEX IF NOT EXISTS idx_privacy_change_events_vault_record ON privacy_change_events (vault_record_id)`,

    // ─── Household-subject scope upgrade (issue #3658) ───────────────────────
    // Runs LAST: the CREATE TABLE bodies above already carry `subject_id` on a
    // fresh install, so these are no-ops there. On an existing install they add
    // the column, backfill every pre-existing row to `self`, and lock it down.
    // Free-text context for a consent row (who witnessed it, where the signed
    // form lives). Added with the table's subject scope (#3658).
    `ALTER TABLE privacy_consents ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`,
    ...subjectScopeUpgrades,
    // `self` always consents — the install owner IS the self subject, so the
    // engine guard must never refuse them. Written once (guarded by NOT EXISTS)
    // so an install that predates #3658 and never created a vault record still
    // has a consent row, and so re-running the DDL never appends duplicates.
    `INSERT INTO privacy_consents (id, subject_id, scope, method, note, granted_at)
     SELECT gen_random_uuid(), '${SELF_SUBJECT_ID}', 'pii_vault', 'self',
            'seeded: the install owner is the self subject', NOW()
     WHERE NOT EXISTS (SELECT 1 FROM privacy_consents WHERE subject_id = '${SELF_SUBJECT_ID}')`,
    // Now that `subject_id` exists on the case ledger, the per-(broker,subject)
    // uniqueness the scan/opt-out upsert relies on.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_broker_cases_broker_subject ON privacy_broker_cases (broker_id, subject_id)`,
    // "Every record for subject X" — the primary list filter once a second
    // household member exists.
    `CREATE INDEX IF NOT EXISTS idx_privacy_vault_records_subject ON privacy_vault_records (subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_orgs_subject ON privacy_orgs (subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_change_events_subject ON privacy_change_events (subject_id)`,
    `CREATE INDEX IF NOT EXISTS idx_privacy_consents_subject ON privacy_consents (subject_id)`,
];
