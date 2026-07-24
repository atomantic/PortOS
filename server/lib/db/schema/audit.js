// Record-audit DDL — the audit-log table + the generic record_audit_log()
// trigger function, the list of audited tables, and the trigger builder.
// Extracted verbatim from ensureSchemaImpl() in server/lib/db.js (#2832) with
// zero behavior change. Parity-locked against server/scripts/init-db.sql by
// db.catalogDdlParity.test.js — keep auditedTables in sync with the
// AUDITED_RECORD_TABLES list there.
export const auditDdl = [
    // ─── Deletion audit log (incident #1248-follow-up) ──────────────────────
    // Append-only forensic trail of EVERY tombstone (soft-delete), un-tombstone
    // (recovery), and hard-delete of user-authored records — written by a DB
    // trigger so it captures deletions from ANY source: the app, a test suite
    // doing raw `DELETE FROM`, or a manual `psql` session. (On 2026-06-13 a CoS
    // agent's test run wiped every universe/series with no trace of who/when;
    // this table closes that gap.) `row_snapshot` keeps the OLD row JSON so a
    // wrongful delete is recoverable from the log alone. Local-only, never
    // federated (no sync_sequence) — each install audits its own mutations.
    // Mirrors the record_audit block in init-db.sql (parity-locked by
    // db.catalogDdlParity.test.js).
    `CREATE TABLE IF NOT EXISTS record_audit (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT,
      record_name TEXT,
      action VARCHAR(16) NOT NULL,
      actor TEXT,
      source_query TEXT,
      application_name TEXT,
      backend_pid INTEGER,
      row_snapshot JSONB,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_record ON record_audit (table_name, record_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_occurred ON record_audit (occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_record_audit_action ON record_audit (action, occurred_at DESC)`,

    // Generic audit trigger. Works on any table via to_jsonb(OLD/NEW) so it needs
    // no per-table column knowledge: `id`/`name`/`title`/`deleted`/`deleted_at`
    // are read out of the row JSON (absent keys → NULL). A row is "deleted" when
    // its `deleted` boolean is true OR its `deleted_at` is non-null (covers both
    // the bool-trio tables and catalog_user_types' deleted_at-only shape).
    // `actor` reads the optional `portos.actor` GUC the app MAY set per session;
    // `source_query` captures current_query() so even an un-attributed raw DELETE
    // is traceable. AFTER trigger: only committed-path rows are logged.
    `CREATE OR REPLACE FUNCTION record_audit_log()
     RETURNS TRIGGER AS $$
     DECLARE
       oldj JSONB := to_jsonb(OLD);
       newj JSONB;
       was_deleted BOOLEAN;
       now_deleted BOOLEAN;
       v_action TEXT;
     BEGIN
       IF TG_OP = 'DELETE' THEN
         v_action := 'hard_delete';
         INSERT INTO record_audit
           (table_name, record_id, record_name, action, actor, source_query, application_name, backend_pid, row_snapshot)
         VALUES
           (TG_TABLE_NAME, oldj->>'id', COALESCE(oldj->>'name', oldj->>'title'), v_action,
            current_setting('portos.actor', true), current_query(),
            current_setting('application_name', true), pg_backend_pid(), oldj);
         RETURN OLD;
       END IF;

       newj := to_jsonb(NEW);
       was_deleted := COALESCE((oldj->>'deleted')::boolean, oldj->>'deleted_at' IS NOT NULL, false);
       now_deleted := COALESCE((newj->>'deleted')::boolean, newj->>'deleted_at' IS NOT NULL, false);
       IF now_deleted AND NOT was_deleted THEN
         v_action := 'tombstone';
       ELSIF was_deleted AND NOT now_deleted THEN
         v_action := 'untombstone';
       ELSE
         RETURN NEW;
       END IF;
       INSERT INTO record_audit
         (table_name, record_id, record_name, action, actor, source_query, application_name, backend_pid, row_snapshot)
       VALUES
         (TG_TABLE_NAME, newj->>'id', COALESCE(newj->>'name', newj->>'title'), v_action,
          current_setting('portos.actor', true), current_query(),
          current_setting('application_name', true), pg_backend_pid(), newj);
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql`,
];

// Attach the audit trigger to every user-authored-content table. Adding a
// table here is all it takes to audit its deletions. (Keep in sync with the
// AUDITED_RECORD_TABLES list in init-db.sql.)
export const auditedTables = [
    'universes', 'universe_runs', 'pipeline_series', 'pipeline_issues',
    'story_builder_sessions', 'writers_room_works', 'writers_room_folders',
    'writers_room_draft_versions', 'catalog_ingredients', 'catalog_scraps',
    'catalog_user_types', 'creative_director_projects', 'threejs_models', 'image_to_3d_models', 'mood_boards',
    'lora_training_runs', 'authors', 'artists', 'albums', 'tracks', 'tribe_people', 'tribe_touchpoints',
];

// Build the per-table DROP/CREATE audit-trigger statements in the original
// order (two statements per table). Appended after auditDdl by the composer so
// the executed DDL is byte-identical to the pre-split inline loop.
export function buildAuditTriggers() {
  const stmts = [];
  for (const t of auditedTables) {
    stmts.push(`DROP TRIGGER IF EXISTS trg_${t}_audit ON ${t}`);
    stmts.push(
      `CREATE TRIGGER trg_${t}_audit AFTER UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION record_audit_log()`,
    );
  }
  return stmts;
}
