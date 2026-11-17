// Creative Commissions DDL — machine-local commission records + feedback.
// Extracted verbatim from ensureSchemaImpl() in server/lib/db.js (#2832);
// idempotent, runs on every boot.
export const commissionsDdl = [
    // Creative Commissions (#2657): a standing, recurring creative brief that fires on a schedule
    // and drives the Creative Director directive pipeline unattended. One row per commission: the
    // full sanitized record in `data` JSONB, with id / name / enabled / created_at / updated_at
    // mirrored into columns for the scheduler's "arm every enabled commission" query. The
    // schedule/runs stay MACHINE-LOCAL (a synced schedule would double-run on every peer).
    // hook here is a conscious act — Phase 2 must split the machine-local schedule
    // from the federatable brief/feedback first.
    `CREATE TABLE IF NOT EXISTS creative_commissions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_creative_commissions_enabled ON creative_commissions (enabled)`,
    // The commission BRIEF federates (record kind `creativeCommission`; schedule/runs/assignment
    // stay machine-local), so a delete must tombstone to propagate. Upgrade for older installs.
    `ALTER TABLE creative_commissions ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE creative_commissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    // Creative Commission FEEDBACK: taste reactions FEDERATE (record kind and sync category
    // `commissionFeedback`) so a 👍/👎 on one machine conditions the next run on another. One row
    // per reaction in `data` JSONB, with soft-delete tombstone columns for the LWW merge (a hard
    // delete never propagates).
    `CREATE TABLE IF NOT EXISTS commission_feedback (
      id TEXT PRIMARY KEY,
      commission_id TEXT,
      run_id TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_commission_feedback_commission ON commission_feedback (commission_id, created_at)`,
];
