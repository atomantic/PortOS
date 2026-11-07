// Native usage store (#15255). Machine-local and NEVER FEDERATED by table: peers
// receive a signed report over the paired usage protocol instead.
//
// `native_usage_sources` holds one row per native source file, which is what lets
// a read skip everything that has not changed and lets usage outlive a swept
// transcript. `source_key` is a SHA-256 of the root-relative path, and `projection`
// holds hashed identities and counters only: no paths, text or raw identifiers.
//
// `native_usage_snapshots` holds whole-document reads with no per-source form: the
// latest Codex account entry and each peer's last verified report.
export const nativeUsageDdl = [
  `CREATE TABLE IF NOT EXISTS native_usage_sources (
    family TEXT NOT NULL,
    source_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mtime_ns BIGINT NOT NULL,
    validator TEXT NOT NULL,
    reread_requested BOOLEAN NOT NULL DEFAULT FALSE,
    projection JSONB NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (family, source_key)
  )`,
  `CREATE TABLE IF NOT EXISTS native_usage_snapshots (
    kind TEXT NOT NULL,
    snapshot_key TEXT NOT NULL,
    payload JSONB NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, snapshot_key)
  )`,
];
