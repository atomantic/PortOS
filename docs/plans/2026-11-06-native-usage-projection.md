# Native usage projection and staged migration

## Goal

Use one authoritative native counter per provider/account. Keep PortOS run
linkage as attribution, not an additional counter. Preserve existing history
until the replacement is validated and recoverable.

## First increment: read-only coverage

`GET /api/usage/native-coverage` explicitly reads Codex's documented
`account/usage/read` through the existing app-server connection. It never starts
an inference turn, changes authentication, updates the ledger, scans transcripts,
or contacts peers. The response is not cached or fed into fleet aggregation.

Codex's native summary and daily buckets describe the currently signed-in
account. They are not scoped to this PortOS instance. The response exposes source,
fetch time, latest reported date, unknown account identity, unknown bucket timezone,
unknown completeness, and an instruction not to sum across instances. Missing
summary fields represented by null remain unknown; null history differs from an
empty returned history. Missing calendar days are not filled with zeros. Invalid,
duplicate-date, negative or unsafe-integer data fails closed as unavailable.

Native token totals do not establish model costs, API-equivalent spend, actual
subscription cost, or per-project attribution. This increment reports native cost
as unknown. It projects no thread-level data or account credentials.

The existing instance ledger is included only as a diagnostic, with its mixed,
measured or estimated provenance. It is not added to the native result. A numeric
difference is deliberately unavailable: account, product, retention and timezone
boundaries have not been matched. Equality between daily and lifetime totals is
not proof of completeness. Other providers explicitly report not integrated,
not unsupported or zero.

## Native dashboard and retained-file coverage

The Usage page defaults to native history. Codex account history is read once on
mount and explicitly refreshed; other providers require a selected read. Legacy
analytics stays available as a separate view, without adding its counters to the
native snapshot. Provider dates retain their calendar meaning and absent days
are not filled with zero. Transport failures label a retained prior snapshot.

`GET /api/usage/native-coverage?family=claude|grok|agy` performs a bounded,
read-only scan of this instance's native files. No family parameter still reads
only Codex. Claude honors `CLAUDE_CONFIG_DIR`; roots and limits are not caller
configurable. Scans skip symlinks, stream bounded records, exclude conflicting
duplicate identities, and report missing fields, malformed lines, read failures,
and caps. Retention and account identity remain unknown. Raw conversation data,
identifiers and paths are not returned or persisted.

Claude's measured retained subset uses unique native assistant message IDs and
all four disjoint token fields. Antigravity reports measured planner-step
coverage but no combined token total because input/cache overlap is unverified.
Grok reports retained turn coverage but no total because per-turn versus
cumulative semantics are unverified. None of these local subsets is an
account-wide history or safe to sum across instances. All costs remain unknown.

These reads do not rebuild the ledger, stop existing writers, change peer sync,
or establish the replacement gates below. Historical rectification remains
pending matched-account coverage evidence and a validated staged cutover.

## Remaining provider work

- Claude: native assistant message IDs and usage fields can support a deduplicated
  retained-history projection, including subagents. Cached aggregate stats are not
  necessarily current. Deleted transcript history remains unknown.
- Antigravity: use conversation identity and step index. Track measured and missing
  usage per step; the presence of some measurements must not mark an entire
  conversation complete. Verify model and cache semantics before pricing.
- Grok: use session and prompt identity with a versioned per-turn contract. Do not
  infer cumulative accounting merely from monotonic values. Confirm native cost
  tick semantics and billing scope before calling a cost actual spend.

## Validation gates before replacement

1. Inventory all participating instances and provider accounts using operator
   access. Do not persist credentials. Establish a stable non-secret account
   identity or explicitly select one authoritative instance for each account.
   Without identity proof, do not merge account-wide snapshots.
2. Record exact native schema/version, source retention, date boundaries,
   measured coverage, missing intervals, duplicate identity conflicts and native
   freshness. Capture immutable projected inputs for a reproducible dry run.
3. Build each provider partition in a separate staging store. No additive backfill
   into the current ledger. Retain unresolved legacy intervals separately with
   explicit unknown/estimated provenance.
4. Compare only matched scopes. Validate native sums, duplicate suppression,
   idempotence, interrupted/repeated runs, unknown fields, account changes,
   model changes, cache tiers, and shared accounts across multiple instances.
5. Validate new code on all instances while the old view remains active. Read-only
   coverage does not require disabling peer syncing.

## Backup, cutover and rollback gates

The following is a plan, not a migration implemented by this increment.

Before cutover, take consistent recoverable backups of every affected ledger,
reconciliation marker, native projection checkpoint and relevant peer-sync state.
Record schema versions and hashes, verify backup readability, and demonstrate a
restore in an isolated store. Preserve provider-native source files unchanged.

A rebuild must operate under a single migration epoch across the participating
instances. Stop old accounting writers and prevent old peer payloads from merging
into rebuilt partitions. Use a validated category-specific sync barrier when
available; otherwise coordinate a brief pause across all instances before any
replacement. Do not disable unrelated sync or assume one local pause is enough.

Activate each validated partition atomically, then resume only writers/readers and
peer payloads that understand its schema and epoch. Account-wide counters are
selected once per account; machine-local disjoint sources are deduplicated before
aggregation. Keep run attribution separate. Verify all instances display the
same authoritative snapshot without adding it to old counters.

On failure, keep the sync barrier, restore each instance's matched backup and
previous code/schema together, verify hashes and totals, and then resume old
writers/sync. Do not roll back one instance while others continue applying new
payloads. Preserve failed staging output for diagnosis without making it active.

No historical replacement, sync configuration change, deployment, or automated
rollback is performed by the coverage endpoint.

## Protocol reference

[Codex App Server: Token usage (ChatGPT)](https://learn.chatgpt.com/docs/app-server)
provides the account history contract. Account history was verified with Codex
0.166.0, without experimental capabilities. Older runtimes or unsupported account
types may reject the method; that must remain unavailable, not zero usage.
