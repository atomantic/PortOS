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
The operator groups them in the machine-local `usageNativeAccountSelections` setting,
naming one authoritative participant per account under an
opaque label. Without a selection for every participant that may hold an account, the
matrix refuses the merge and reports a null total. A failed authoritative read also
refuses, with no fallback to another member. A plan or sign-in change, a lifetime
that went backwards, or restated history across two reports of one participant
refuses until the operator reselects and drops the older report. Those checks detect
a change. They do not prove the account stayed the same.

### Selecting accounts in the Usage view

The native Usage view provides an account-selection drawer for Codex, Claude,
Grok and Antigravity. It reads only local settings and a bounded configured-peer
inventory through `GET /api/usage/native-accounts`; opening the drawer does not
read provider sources or contact peers. Participants use hashed keys, with local,
configured-peer and unavailable-member states. Missing saved members remain
visible instead of being silently removed.

Use an opaque account label, choose its members, and select exactly one Codex
authority. For retained providers, explicitly confirm that the selected retained
history belongs to that account. A shared current subscription or equal totals
does not establish the provenance of old files. Leave mixed or unverified history
unselected. Different accounts require separate rows; one participant cannot be
assigned to two accounts for the same provider.

`PUT /api/usage/native-accounts` saves only this machine's selection slice, using
the revision returned by the read. The revision is compared inside the settings
write queue, so a stale tab cannot silently replace a newer selection, including
a change made through the existing generic settings API. Invalid or unreadable
settings refuse editing rather than becoming an empty selection. Unknown new
members are rejected; previously selected unavailable members can remain until
the operator resolves them. No account credential or raw instance identifier is
stored by this editor.

Saving account assertions requires the existing local or delegated operator
authority, including writes through the generic settings API. On password-free
installs a remote browser cannot make this change; use a browser on the instance
itself, or configure an instance password in Settings → Security and sign in.
Scoped peer credentials never grant account-selection write authority.

A successful save applies the returned selection to the editor and invalidates
the displayed native matrix. Selection-change notifications also invalidate old
or pending account-derived results without starting another source scan. Use
**Read native sources** explicitly after saving. Selections stay machine-local
and never change peer sharing, provider authentication, active usage history or
cutover state. These assertions enable a diagnostic union; they are not evidence
that history is complete or permission to activate staged history.

## Read-only local and configured-peer dashboard matrix

The Usage page's **Read native sources** action uses `GET /api/usage/native-matrix`
to capture all four current readers into a v5 report and sum it with any peer reports.
A read uses the standalone capture's budgets for bytes, lines, entries and records, so
it covers the whole retained history, and it reads only sources that changed since the
last collection (see [the store](#collected-usage-store-15255)). All providers share one 45-second deadline. Scan
limits and unknown coverage stay visible. This is not a staged replacement for the
active ledger.

The default endpoint reads the local instance only. The URL-backed **Configured
peers** scope uses `GET /api/usage/native-matrix?scope=fleet` on an explicit read.
Changing scope does not read sources or show a snapshot from the old scope.
Neither scope creates account selections or maps machines by matching counters.
Existing operator selections are applied as stored. Missing selected participants are
listed explicitly and never count as zero; a retained-file sum adds the reports that
arrived and carries a `member-report-missing` finding. A locally authoritative Codex
account snapshot may still be shown once, with missing member reports visible. Neither
case claims complete history or verified account identity.

Fleet collection contacts at most eight registered peers, two at a time, and
lists at most 64 registry entries with explicit inventory/collection limits.
Only enabled, user-established, paired peers with effective `usage` sharing
qualify. No configuration or pairing is created. The existing usage-category
policy still applies when the older content-sync master switch is off.

`GET /api/usage/native-report/v2?challenge=<64 hex>` exchanges only a local v5
report with a currently authenticated paired usage peer. `v1` answers a v4 report for
peers that have not upgraded, and a collector asks for it when `v2` answers 404 or
403. A domain-separated HMAC binds the report to its source, audience and fresh
challenge. Strict schemas, content/evidence hashes, a 1 GiB memory-safety bound, a
60-second whole-request deadline,
a five-second body-idle deadline, and five-minute capture freshness with a
30-second future allowance constrain each response. A response cannot redirect
credentials, fall back to Basic auth, impersonate another participant or forward
another peer's records. Current pairing, category, URL and identity bindings are
checked after waits and again before the collection is released.

Old endpoints, unpaired/disabled peers, stale or oversized reports, conflicting
identities, unreadable registries and partial failures stay explicit. Failed
reports are omitted from matrix inputs, never converted to zero. A successful
collection means the requested reports arrived; it proves neither historical
completeness nor membership in the same provider account.

Only aggregate counters, coverage, safe participant keys, machine sums and refusal
reasons reach the UI. A v5 report holds no record identity. Per-record projections
travel only in a v4 report answering a peer that has not upgraded, never in browser
output. Grok cost ticks
are an unverified native signal, not dollars or subscription spend. Antigravity's
input, output, cache and output-decomposition counters stay separate because the
combined total remains unverified. Native and legacy counters are never added.

Concurrent requests share only the in-flight read. A later refresh collects new
sources. The UI labels any prior result retained after a request error as stale. The
action does not run on boot or poll, write the ledger, change sync, invoke inference, or
perform deployment. Reports are not forwarded from another host. Durable capture for
staging, account-map verification and live checks on each participant remain tracked by
#15097; this read-only UI does not close that issue or the staged recovery in #15031.

## Collected usage store (#15255)

Every read used to start over, so month-old files were parsed again, and usage vanished
when a transcript was swept: Claude Code's documented default retention is 30 days. Each
machine now keeps what it collected in `native_usage_sources`, one row per source file:
its family, a SHA-256 of its root-relative path, size, mtime, validator and record
projection. See [STORAGE.md](../STORAGE.md#native-usage-store).

- **Unchanged** (same size, mtime and validator): one `lstat`, however old the file is.
  A date cut-off would miss a resumed month-old session.
- **Changed:** read whole, replacing only its own row. There is no byte-offset resume: a
  re-read of the few active files is cheap, and offsets would need prefix checks.
- **Deleted:** the row stays and still counts, because deletion is retention rather than
  restated usage. `collected-sources-detached` says that some counted sources are gone.
- **Validator change:** that family's sources that still exist are re-read.
- **Copied or moved:** a new row with the same record identities, which still deduplicates.

A report is the existing unions over every stored row, built by the same reader code as
a full read. A row holds what its file contributed before the final resolution, so copies
split across files fold as they would in one read, and a stored report equals a full read
of the same tree byte for byte (`evidenceHash`). `nativeUsageCollection.test.js` checks
this over the #15230 corpus with each copy collected in a separate run. A deleted source
is the deliberate exception, since its usage is exactly what a full read would lose.

**A run is bounded, not the data.** Its 45-second budget is shared across providers,
including the Codex read, and sits inside the 60-second peer deadline. A run that stops reports
`scan-stopped-early`, and the next run continues, because finished sources are already
saved. An unfinished read saves nothing. An Antigravity database that is refused or has
live sidecars is read and reported on every run and never saved, so a transient failure
cannot stick; its earlier row, if any, keeps counting.

**Collection runs on explicit reads and daily** (`nativeUsageCollectionSchedule.js`), so a
sweep cannot remove usage nobody happened to read. The daily run reads local files only,
with no inference, Codex read or peer contact. Nothing scans at boot, and a missed slot
is not caught up. **Rebuild from sources** (`POST /api/usage/native-sources/rebuild`) marks
every row for a re-read, for an in-place rewrite that keeps size and mtime. Rows whose
source is gone are never removed.

**Codex** has no narrower read, and `account/usage/read` is cheap, so every explicit read
still calls it. The latest projected entry is stored, never the raw account read, which
holds an email. After a failed refresh the provider shows that entry with
`retained-snapshot`, which cannot satisfy an authoritative selection. Signed-out and
missing-runtime results stay as they are. `history-restated` is unchanged.

**Peers** answer the same way: the request collects what changed and reports from the
store, as v5 rollups (or a v4 record list for an older collector). The requester keeps
each peer's last verified report in `native_usage_snapshots`. When a later read fails it
shows that report, labeled stale, with `peer-report-retained` and the original capture
time. A refusal, a disabled or unpaired peer, or a changed pairing shows nothing, so
revoking a peer hides its retained report. Rollups cover every stored record; only the
v4 record list for an older collector is still capped at 100,000 records and marked
`truncated` beyond that.

### Machine rollups (report version 5)

Each machine resolves its own copies and reports per-day, per-model rollups instead of
a record list. The rollup block is specified in
[the model attribution record](./2026-11-07-native-usage-model-attribution.md), and
`server/lib/nativeUsageRollups.js` implements it. The Usage view adds machine totals
under `machineRollups`, because no vendor documentation read for #15230 describes
syncing these files between machines. A transcript copied to a second machine by hand
counts twice, and the Usage page says so, along with the fact that Claude cloud sessions
may be missing. Antigravity has no validated model labels, so its buckets carry the
reason `model-unverified` and no combined total. The sections below describe the record
lists that the standalone capture and its staged matrix still use.

## Antigravity native CLI capture (report version 4)

Staged capture reads `~/.gemini/antigravity-cli/conversations/*.db`, not the
incomplete overlapping transcript or generator-metadata views. The validated
CLI 1.5.2 format has SQLite `user_version=1`, `application_id=0`, exact ordinary
`steps` and `trajectory_meta` column shapes, `step_format=0` and protobuf
`step_generation_version=0`. SQLite's schema change counter is not a format
version. Historical runtime versions are unknown, not inferred from the installed
CLI. Unknown schemas, generated columns, malformed protobuf, missing identities,
missing usage on planner/checkpoint steps and scan caps refuse a usable union.

The reader copies each bounded, stable source into a private temporary snapshot
and opens only that copy with immutable read-only SQLite. Source sidecars, links,
file changes and unsupported containers refuse the projection. WAL header flags
are accepted only with absent sidecars and an unchanged source around the copy.
No source locks, writes, inference, credential reads or native CLI invocation are
needed. The strict wire decoder skips content and response-header fields; it
accepts absent proto3 scalar counters as zero only inside a present validated
usage message. It rejects truncated, duplicate or wrongly typed fields and
unsafe integers. Snapshots are removed after each read.

Completed planner and checkpoint records preserve input, output, cache read,
cache write, thinking output and response output separately. Output decomposition
is checked, but cache is never subtracted from input or assumed to overlap. No
combined token total, inferred marketing model, price or bill is invented. Native
numeric model/provider enums and UTC timestamps survive the projection. Model
cost metadata has unverified units and is ignored.

Account-scoped merging requires an explicit `agy` selection with
`historyScope: operator-confirmed-retained-history`. Message and response IDs are
separately hashed with domain separation, independent of host, filename or root.
Copies agree on all counters, enums, type and timestamps or are excluded, and
both identity aliases survive conflict tombstones. Reused message or response IDs
in different account selections refuse the account partition. These IDs are a
practical observed identity contract, not proof of a globally unique vendor ID.
Repeated capture reads sources again; no previous total is used as a fallback.

App and IDE `conversations` containers are counted as present but unverified.
Their `.pb` wrapper has not been validated and must not use the CLI decoder.
Legacy-only CLI history is also explicit unknown coverage. Thus retained unions
remain partial, with unknown lifetime completeness and cost. Report versions
1–3 remain strictly readable, but their Antigravity entries lack the required
native projection and cannot satisfy an account union. This adapter does not
change the ledger, peer synchronization or deployment. The local dashboard now
uses this adapter through the bounded v4 matrix read above.
Fleet validation and App/IDE recovery remain tracked in #15097.

Official roots and transcript context: [hooks](https://antigravity.google/docs/hooks).
The [headless contract](https://antigravity.google/docs/cli/headless/) distinguishes
per-step usage from cumulative `result.usage`; it does not establish App container
encoding or legacy counter overlap. The SQLite/protobuf acceptance above is a
bounded installed-format contract, not a claim that those docs specify the DB.

## Grok persisted usage capture (report version 3)

The staged capture now reads only
`~/.grok/sessions/<encoded-cwd>/<session-directory>/usage.json` for Grok.
It does not call `grok usage` or mix in `updates.jsonl`: several raw events can
collapse into a single persisted native turn. The local dashboard uses this same
reader through the bounded v4 matrix read; the older native-coverage endpoint
remains a separate legacy diagnostic.

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
- Antigravity: the v4 CLI SQLite reader above supersedes transcript-step counters.
  Completed message/response identities support selected retained-history union,
  with six separate measured counters. Combined input/cache semantics and App/IDE
  containers remain unverified, and runtime/model pricing is not inferred.
- Grok: the v3 persisted session/turn reader above supersedes raw update events.
  Verified native turn fields support deduplicated retained-account unions;
  cache/reasoning breakdowns are not added to explicit totals. Cost-tick conversion
  and billing scope remain unconfirmed.
- All providers: retention is unknown. Claude, Antigravity and Grok can union
  selected retained records when all required compatible reports are supplied.
  Missing peer reports, historical account membership and deployment validation
  remain open; the local dashboard does not establish fleet completeness.

## Version 2: deduplicated Claude retained records

Version 2 introduced Claude retained-record union; current capture emits version 4
and the matrix still accepts versions 1–3. It never upgrades aggregate-only v1
transcript evidence into records. CLI capture and the bounded local dashboard
now both use the strict Claude projection, capped at 100,000 identities. A truncated
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

Grok billing scope and Antigravity App/IDE containers still require validation.
The staged native adapters above do not establish complete lifetime coverage or
replace the active ledger. Fleet and cutover gates remain open.

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
That barrier was implemented in #15098 and retired unused in #15279, after #15271
chose to overlay native history at read time instead of migrating the ledger.

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
