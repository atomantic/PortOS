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

## Provider and account coverage contract

`server/lib/nativeUsageContract.js` is the read-only contract #15031 consumes.
Versioned synthetic fixtures live in `server/lib/fixtures/nativeUsage/v1/`. Each
participant runs `node scripts/native-usage-report.js capture > participant.json`.
One machine then runs `node scripts/native-usage-report.js matrix <reports>...`,
adding `--summary` for a short operator view. Neither command calls a model, writes
the ledger, contacts a peer, or changes authentication or sync. Only the Codex read
needs the runtime, and it uses the fixed `account/read` and `account/usage/read`.

Each provider entry records source and runtime version, account or machine scope,
date boundary and timezone, freshness, retention, missing intervals, scan caps,
duplicate conflicts and supported token and cost fields. Reports have no paths,
transcript text or native identifiers, and a strict schema refuses any extra field.
A participant is named only by a hash of its random instance id.

The same inputs produce byte-identical output. `evidenceHash` covers source-derived
facts and stays equal across captures of an unchanged source, unless a scan stopped
early (`reproducibility: scan-stopped-early`) or the live Codex read has moved.
`contentHash` also covers the capture time.

**Account identity.** Codex's `account/read` holds an email and no id that is safe
to publish, and a hash of an email can be reversed with a dictionary. So `accountKey`
is always null and identity is `unknown`. Matching totals never group participants.
The operator groups them in the machine-local `usageNativeAccountSelections` setting
(`PUT /api/settings`), naming one authoritative participant per account under an
opaque label. Without a selection for every participant that may hold an account, the
matrix refuses the merge and reports a null total. A failed authoritative read also
refuses, with no fallback to another member. A plan or sign-in change, a lifetime
that went backwards, or restated history across two reports of one participant
refuses until the operator reselects and drops the older report. Those checks detect
a change. They do not prove the account stayed the same.

## Grok persisted usage capture (report version 3)

The staged capture now reads only
`~/.grok/sessions/<encoded-cwd>/<session-directory>/usage.json` for Grok.
It does not call `grok usage` or mix in `updates.jsonl`: several raw events can
collapse into a single persisted native turn. The existing dashboard's raw-event
coverage remains diagnostic until the separate cutover work is validated.

The supported shape was observed with Grok 1.0.77's persisted-usage reader. There
is no native format version or finalization flag in the observed file, and the
current CLI version does not identify the version that wrote historical records.
A snapshot contains `sessionId`, `updatedAt`, `session`, and `turns`; each turn has
`turnNumber`, `endedAt`, seven native token/call counters, `turnCount`, and nullable
`costUsdTicks`. Model labels and detailed model usage are not exported. Session
counters must equal the sum of the native turn counters, with unique positive
turn numbers and `turnCount` agreement. Bad snapshots exclude their identified
turns rather than publishing arbitrary winners.

Records are hashed by the native session ID plus turn number, independent of
machine and directory. Explicit `totalTokens` is used: cache and reasoning are
breakdowns and never added again. Input/output/total consistency and the observed
cached-read/input and reasoning/output subset relations are validated; no
cache-creation inclusion rule is assumed. Copies with conflicting token fields
or timestamps are excluded. A conflicting copy cannot be hidden by a clean peer.

Grok account selections require `historyScope: operator-confirmed-retained-history`,
like Claude. Shared current sign-ins alone cannot establish historical membership.
Version 3 captures carry Grok projections; version 1 and 2 reports remain readable,
but cannot supply a Grok retained union without the new projection. Missing
members, ungrouped sources, cross-account copied identities, truncated projections
and unsafe token totals refuse a combined result. At most 100,000 unique records
are exported per participant. Scan limits and missing/invalid snapshots remain
visible; even an exhaustive scan yields only partial retained history, never a
complete account history or proof of zero usage. Custom roots and WSL installations
are not discovered by this reader.

Native costs are separate from tokens. Known `costUsdTicks` are reported in their
native integer unit with measured, missing and conflicting-record counts. Missing
costs can be filled by an otherwise identical copy; contradictory costs stay
unknown without discarding valid tokens. The conversion to dollars and scope
(subscription allowance, API equivalence or actual billing) are unverified, so
actual spend and estimated API-equivalent USD remain null. No inference, ledger
write, settings change, migration, peer sync, restart or deployment is part of this
increment. Reports remain private because opaque record keys are linkable.

## Remaining provider work

Validated against fixtures and a read-only scan of one install's retained files, with
no values published. Other installs may run other runtime versions.

- Codex: verified on runtime 0.166.0. Daily buckets carry no timezone and are kept as
  provider calendar days. Reported history can have gaps; these are listed as missing
  intervals and are not zero usage. The contract's only arithmetic check is that daily
  buckets cannot exceed the lifetime total. Agreement does not prove completeness.
- Claude: one API response is written several times while streaming. The emissions
  share a message and request ID and input and cache counters, while output grows and
  only the final one has `stop_reason`. These are resolved to the final emission
  instead of being excluded as conflicts, which had dropped a large share of retained
  messages. A copy with another request or input is still a conflict and is excluded.
  Cache-creation breakdowns matched their totals on every sampled message. The four
  token fields are summed as disjoint per Anthropic's usage contract; retained data
  cannot prove that independently. Deleted history stays unavailable.
- Antigravity: conversation plus step index identifies a record. Many completed
  planner steps have no token fields, and some conversations have index gaps, so
  conversations are reported as partly measured. Cached reads often exceed
  `input_tokens`, which rules out `input_tokens` always including them, but the
  remaining steps do not establish a disjoint rule, so no combined total is exposed.
  Planner steps carry no model or runtime version, so both stay unknown.
- Grok: session plus prompt identifies a turn. Native turn counters are reported but
  not summed, and monotonic values are not read as cumulative. The ledger's shape
  detection (`looksCumulative`) is a billing heuristic, not native evidence.
  `costUsdTicks` is counted as an unverified signal, not converted to spend. Its
  billing scope is unconfirmed.
- All providers: retention is unknown. Version 2 can union the measured Claude retained
  subset as described below. Antigravity and Grok still refuse fleet aggregation.

## Version 2: deduplicated Claude retained records

Capture now emits contract version 2; matrix accepts version 1 for existing Codex
snapshots, but never upgrades aggregate-only v1 transcript evidence into records.
The dashboard still uses its bounded aggregate-only scan. Only CLI capture opts
into a strict Claude record projection, capped at 100,000 identities. A truncated
projection refuses union, since an omitted conflict could otherwise be resurrected
by a copy from another participant. Other scan caps remain visible findings on a
partial retained subset, never proof of historical completeness.

Each projected record contains a SHA-256 domain-separated native message key,
separately hashed request key, four nullable token counters, final/conflict/field
consistency flags, and its earliest observed UTC timestamp. The timestamp is
observation metadata, not proof of a billing-day allocation. No model attribution
or daily token partition is inferred. Raw IDs, source paths, account names and
transcript content do not travel. These opaque keys are linkable pseudonyms, not
anonymization: keep the reports private and do not publish them to an issue.

An operator may select a Claude retained-history account in the existing local
selection setting, alongside any Codex selections:

```json
{
  "family": "claude",
  "accountLabel": "acct-a",
  "historyScope": "operator-confirmed-retained-history",
  "members": ["<participantKey>"]
}
```

This asserts that the retained files belong to that account. Current shared
sign-ins alone cannot establish which account generated older files. If an install
has mixed-account historical files, do not select it until provenance is resolved.
The setting remains machine-local; no selection or sync setting is changed by
capture or matrix. Codex still selects one authoritative account snapshot and
never sums the other participants' snapshots.

The Claude matrix unions message identities, not participant totals. Copies and
compatible streaming partials count one final response. Conflicting request IDs,
inputs or final counters are excluded; a conflict tombstone on any participant
cannot be overridden by another participant's valid-looking copy. Inconsistent,
unfinalized, undated and missing-field records are excluded with counts. Unmatched
participants, missing reports/projections, cross-account duplicate identities and
unsafe-integer totals refuse the union. Versions and source findings stay attached.

A usable union is always `partial`, labelled `selected-account-retained-records`
with unknown completeness and retention. It exposes only verified retained tokens,
not account lifetime, subscription charges, API-equivalent cost or actual spend.
This is reproducible staged input only: no history writes, cutover, deployment,
provider inference, new source-root scan or live-account mutation is implemented.

Grok still needs version-specific persisted turn semantics and billing scope
verified against its native usage command. Antigravity still needs its multiple
native roots and transcript versions validated, including the distinction between
per-step usage and cumulative session results. Neither is added up by this change.

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
That barrier is [implemented](../USAGE_CUTOVER_BARRIER.md) (#15098) and is not active
on any instance until an operator acquires it.

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
