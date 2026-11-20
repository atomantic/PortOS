/** PostgreSQL schema for machine-local AI usage and indexed reconciliation markers. */

export const usageLedgerDdl = [
  `CREATE TABLE IF NOT EXISTS usage_ledger_buckets (
    bucket text NOT NULL,
    key_hash text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    PRIMARY KEY (bucket, key_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_ledger_markers (
    kind text NOT NULL,
    id text NOT NULL,
    value jsonb NOT NULL,
    claim_at bigint,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ledger_claim_at ON usage_ledger_markers (kind, claim_at)
    WHERE claim_at IS NOT NULL`,
];
