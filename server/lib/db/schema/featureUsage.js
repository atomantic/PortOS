// Feature-usage DDL: one row per feature area per local calendar day, counting focused page visits.
//
// Machine-local like `user_action_events`: excluded from peer sync, guarded in sharing/peerSync.test.js. The primary
// key is the upsert target (`ON CONFLICT (area_id, day)`), so a daily counter needs no id column or extra index.
// Retention (90 days) is enforced inline by the recorder, not by a cron.
//
// Deliberately NOT in `auditedTables` (server/lib/db/schema/audit.js): the counters regenerate from use, and an
// audit trail of them would only copy usage history into `record_audit`.
export const featureUsageDdl = [
    `CREATE TABLE IF NOT EXISTS feature_usage_days (
      area_id TEXT NOT NULL,
      day DATE NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (area_id, day)
    )`,
];
