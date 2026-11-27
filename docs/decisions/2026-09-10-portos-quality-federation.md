# ADR: Numeric app quality federation

**Date:** 2026-09-10
**Status:** Accepted, including the v3 snapshot amendment


## Context

Several installs can audit the same managed repository. The quality panel
combines evidence by normalized Git-origin fingerprint across this install,
direct registered peers and matching checked-in release snapshots.

## Decision

Query and serve only enabled, outbound-approved sync relationships. Transfer
validated numeric evidence, enums, timestamps and opaque run hashes through
peer schema v1. Source prose, credentials, raw IDs and local paths stay local.
A peer serves only its own records. Access remains subject to configured peer
authentication. Reads perform no AI work. Missing, malformed, incompatible or
unreachable peers leave local evidence usable.

The latest evidence per category wins (run hash breaks timestamp ties). Only
broad medium/high-confidence evidence within 30 days contributes to the
equal-weight category score. A newer partial assessment supersedes an older
one. UTC history uses evidence available by each day's end.

`.quality.json` is the repository projection, distinct from peer schema v1.
Readers support earlier snapshots and the historical `quality-snapshot.json`
fallback. File schema v3 unions published history from the default and open
snapshot branches with current local measurements. Real timestamps take
precedence over conflicting date-only legacy rows. Unknown future schemas and
invalid or oversized snapshots stay untouched. Refuse overflow at 250,000
rows or 16 MiB. Freshness applies to scoring, while published dates persist.

## Consequences

The database remains the primary store. Snapshot automation is per-app opt-in.
`npm run quality:snapshot` is the explicit PortOS trigger. It uses a separate
worktree and merge-on-green PR when there are changed bytes and evidence.
Shipped evidence keeps its original assessment dates and is not re-exported
as a local peer measurement.
