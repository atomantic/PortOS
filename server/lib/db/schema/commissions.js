// Creative Commissions DDL — machine-local commission records + feedback.
// Extracted verbatim from ensureSchemaImpl() in server/lib/db.js (#2832);
// idempotent, runs on every boot.
export const commissionsDdl = [
    // Creative Commissions (#2657, Autonomous Creation Engine — Phase 1). A
    // standing, recurring creative brief that fires on a schedule and drives the
    // Creative Director directive pipeline unattended. One row per commission:
    // the full sanitized record (brief / schedule / generation / feedback /
    // runs[]) in `data` JSONB, with id / name / enabled / created_at / updated_at
    // mirrored into columns for the scheduler's "arm every enabled commission"
    // query. INTENTIONALLY MACHINE-LOCAL — never federated (a synced schedule
    // would double-run on every peer, same rationale as seriesAutopilotScheduler),
    // so there is NO sync_sequence and NO deleted/deleted_at tombstone: deletes
    // are hard deletes, mirroring tribe_people (ADR
    // docs/decisions/2026-06-26-tribe-and-universe-runs-local.md). Adding a sync
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
    // The commission BRIEF federates as of #2686 (record kind `creativeCommission`,
    // schedule/runs/assignment stay machine-local) — a delete must tombstone so it
    // propagates. Idempotent upgrade for installs predating the split.
    `ALTER TABLE creative_commissions ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE creative_commissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
    // Creative Commission FEEDBACK — the split-record federation half (#2686).
    // Unlike the machine-local commission above, taste reactions FEDERATE so a
    // 👍/👎 rated on one machine conditions the same commission's next run on
    // another. One row per reaction; the full sanitized record in `data` JSONB,
    // with commission_id / run_id / created_at / updated_at mirrored for the
    // per-commission hydration query, plus the soft-delete tombstone columns the
    // LWW merge needs (a hard delete never propagates). Record kind
    // `commissionFeedback`, sync category `commissionFeedback`.
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
