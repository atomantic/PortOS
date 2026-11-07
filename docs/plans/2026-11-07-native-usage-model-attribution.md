# Native usage model attribution

> **Superseded (#15271, #15272).** The Usage report now reads each coding app's own records directly (`server/services/nativeUsageHistory.js`). The staged projection, native reports, account selections and rehearsal tooling described here were removed; this record is kept for history.

## Context

Decision record for #15230, a parallel research increment of #15031. The v4 native
reports accept Claude and Grok token records but carry no model. This record says
what the sources support, what the extension must do, and which synthetic corpus
proves it. #15252 adopted the peer rollup below as report version 5 in
`server/lib/nativeUsageRollups.js`. The projection v2 form stays a proposal, because
it applies only if #15031 keeps a record union.

Model attribution partitions tokens that are already accepted. It never adds,
removes or re-totals them, and it establishes neither API-equivalent cost nor actual
spend. A label is what the responding endpoint reported, not a verified vendor model
and not a pricing key.

**Owner direction (2026-11-07).** Paired peers are the owner's own trusted machines, so
PortOS should not cap what they report. Peers should only need to send aggregate
metrics, and reconciling every record should not be a goal where a subscription source
supplies the data. Usage already collected should be stored, so static history is never
read twice. This record follows that direction; #15252 and #15255 track the production
work.

## Source evidence

Checked 2026-11-07 against Claude Code 2.1.319 and Grok 1.0.77 (`50ca579fa996`).
Structural probes printed field names, types and aggregate arithmetic only, over one
retained corpus on one install. No inference call was made. **Vendor** means
published or vendor-shipped documentation. **Observed** means it held for every
retained record but no vendor promises it.

| Provider | Field or question | Status | Evidence |
| - | - | - | - |
| Claude | Retained `projects/**/*.jsonl` entry format | Internal, no contract | Vendor: [sessions](https://code.claude.com/docs/en/sessions) says the format "is internal to Claude Code and changes between versions" |
| Claude | `message.id` groups copies; deduplicate by it | Vendor (SDK stream); observed (files) | [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) |
| Claude | `message.model` present at `message_start`, `stop_reason` null there | Vendor (API) | [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Messages](https://platform.claude.com/docs/en/api/messages) |
| Claude | One label per identity across partial, final and copied entries | Observed | ~34k identities over 24 runtime versions (2.1.286 to 2.1.319): none with two labels, none with no label, no partial/final disagreement |
| Claude | Input, output and both cache fields are disjoint | Vendor (API) | Messages: total input is the sum of the three input fields |
| Claude | Final transcript copy holds the real output count | Observed only | Every identity with partial and final copies had final > partial. The SDK stream's per-step `output_tokens` is a documented placeholder, so this is a transcript fact, not a stream fact |
| Claude | `<synthetic>` label | Observed, undocumented | A small minority of entries, all zero usage, each with a `stop_reason`. It is a placeholder, not a model |
| Claude | Gateway or third-party label shapes | Unverified | Only first-party shapes were retained here; the grammar below admits routed forms without trusting them |
| Grok | Retained `sessions/<cwd>/<session>/usage.json` format | No field contract | Vendor-shipped `17-sessions.md`: use `grok usage` "instead of reading session files". It documents the envelope only (`sessionId`, `updatedAt`, `session`, `turns`). `grok usage <id>` matched the file byte-for-byte after key sorting on all 6 sampled sessions |
| Grok | Turn counters and `turns[].modelUsage` are per turn | Observed | ~440 turns over ~360 sessions: rows sum to the turn in all 8 fields, session counters equal the turn sums, and turn totals fell between adjacent turns about half the time, which rules out cumulative |
| Grok | Session `modelUsage` | Observed redundant | Equals the sum of turn rows here. The vendor says session totals may include history inherited by resume or fork, so it is never allocation evidence |
| Grok | `primaryModelId` | Label only, undefined | Never documented. It equalled the only row in every observed turn, which proves nothing about mixed turns |
| Grok | Multi-model turns | Vendor (headless result); unobserved in `usage.json` | `14-headless-mode.md`: subagents appear "under their own `modelUsage` keys". Zero multi-row turns retained here, so the rule below fails closed |
| Grok | `inputTokens` includes cache, `outputTokens` includes reasoning | Observed; vendor text agrees on input | `totalTokens = inputTokens + outputTokens`, `cachedReadTokens <= inputTokens` and `reasoningTokens <= outputTokens` for all rows and turns. The vendor calls the ACP `inputTokens` "the **full** prompt sum". The headless `input_tokens` is a different, uncached projection and must not be mixed in |
| Grok | `cacheCreationTokens` relation to input | Unverified | Always zero here. It stays its own column and is never added to a total |
| Grok | `usageIsIncomplete` | Vendor semantics, observed flag | "token totals may under-count subagents". Set on about 7% of retained turns, with rows still reconciling. The current reader drops it (#15247) |
| Grok | Compaction and side-model calls per model | Unavailable | Vendor: excluded from `usage`. Model buckets cannot include them |

`server/lib/providerTranscriptUsage.js` buckets a mixed `updates.jsonl` turn under its
first `modelUsage` key and treats those rows as cumulative. Neither assumption applies
to persisted turns, and neither may be copied. #15111 and #5831 do not supply this
contract.

## Outcome vocabulary

Every accepted record lands in exactly one place, so models, unknown and unallocated
always sum to the accepted provider total, field by field.

- **`models`** holds validated labels with counters that reconcile.
- **`unknown`** means no usable evidence: `model-missing`, `model-sentinel`,
  `report-without-model-capability`.
- **`unallocated`** means evidence exists but cannot be honored: `model-conflict`,
  `model-label-invalid`, `model-label-limit`, `model-rows-invalid`,
  `model-sum-mismatch`.
- **`refused`** records never entered the provider total, so they fill no bucket. It
  keeps the provider findings as they are: `conflicting-records`,
  `missing-record-fields`, `undated-records`, `unfinalized-records`. A Grok turn the
  reader already excluded travels as a tombstone, so the union reports it as
  `conflicting-records` even when the local reason was a missing date.

A missing or contradictory model is never filled from today's configured default, and
unknown metadata never erases a valid provider total.

## Resolution rules

**Provider acceptance runs first and does not change.** Record identity, deduplication
and acceptance stay as `unionNativeClaudeRecords` and `unionNativeGrokRecords` define
them. Labels must stay out of `recordKey`, `requestKey` and the reader's copy
`signature`, so a label can never create or hide a provider conflict.

**Evidence folds as a join-semilattice.** Each copy contributes one element, ranked
`report-without-model-capability` < `model-missing` < `model-sentinel` < usable
evidence (a label or rows, or one of the invalid reasons) < `model-conflict`. The join
takes the higher rank. Two different elements at the usable rank join to
`model-conflict`, which absorbs everything. The join is commutative, associative and
idempotent, so a reader can fold its files and a union can fold its reports with the
same result in any order or grouping. There is no winner, no first-seen and no latest.

**Claude.** One record gets one label, covering all its accepted counters. Absent,
`null` or blank labels are `model-missing`. `<synthetic>` is `model-sentinel`, never a
model, and neither competes with a real label. Anything failing the grammar is
`model-label-invalid`, and its raw value is dropped. Two labels, or a label plus an
invalid value, are `model-conflict`: contradictory labels on otherwise identical
counters keep the total and name no model.

**Grok.** Only `turns[].modelUsage` is evidence, and `primaryModelId` is never read for
allocation. Absent or empty rows are `model-missing`, even when a primary label is
present. A split is accepted only when these checks pass, in this order, with the first
failure naming the reason:

1. every label passes the grammar, or the turn is `model-label-invalid`;
2. the row count is within the cap and each row holds all seven counters with
   `totalTokens = inputTokens + outputTokens`, `cachedReadTokens <= inputTokens` and
   `reasoningTokens <= outputTokens`, or the turn is `model-rows-invalid`;
3. rows sum exactly to the turn in `inputTokens`, `outputTokens`, `cachedReadTokens`,
   `cacheCreationTokens`, `reasoningTokens`, `totalTokens` and `modelCalls`, or the
   turn is `model-sum-mismatch`.

One failure moves the whole turn to `unallocated`, because a partial split would
misstate the rest. Cache and reasoning are read as columns and never added to a total.
`usageIsIncomplete` on any capable copy marks the record `incomplete`, a lower bound,
without changing its bucket. Cost ticks and `costIsPartial` are not reconciled and never
enter a bucket.

## Collection and reporting

**Each machine stores what it collected (#15255).** The store keeps one record
projection per source file, with that file's size and mtime:

- an unchanged source costs one `stat`, however old it is;
- a changed source is re-read and replaces only its own projection;
- a deleted source keeps its projection, because Claude's default 30-day retention
  removes transcripts while the usage still happened.

Staleness comes from those file facts rather than a date cut-off, so a resumed
month-old session is still picked up. Totals are the existing unions over every stored
projection. Evidence folds the same in any order or grouping, so that matches reading
everything at once, and a file copied to a new path still deduplicates by identity.
Codex has no narrower read: `account/usage/read` returns its history in one cheap call.

**Peers report aggregates.** Per-record resolution stays on the machine that read the
files. A new report contract version 5 adds this block to the Claude and Grok entries:

```text
modelUsage = { version: 1, buckets: [{ day, kind, key, counters, incompleteRecords? }] }
  day       UTC date of the accepted record's `at`
  kind      model | unknown | unallocated
  key       validated label for model, otherwise a reason from the vocabulary above
  counters  the provider total's field names, with no cost and no record identity
  incompleteRecords   Grok only: how many records in this bucket are lower bounds
```

Antigravity entries carry the same block with the reason `model-unverified`, because its
numeric model enums have no validated labels, and with no combined total.

Buckets are unique, sorted by day, kind and key, and sum exactly to the provider total.
Size follows days times labels rather than records: a year across ten labels is under
1 MiB. `aggregate.json` pins accepted and refused examples.

**What limited the data (#15252).** These were PortOS's own settings, not technical
limits, and #15252 removed both:

- The dashboard and peer read budget stopped at 128 MiB of file bytes. On one real
  install that was 999 of 33,709 Claude records, in 0.2 seconds. Without it, the whole
  history read in about 3 seconds as an 8.76 MiB record list.
- The 16 MiB peer limit refused a whole report, at about 61,000 Claude records.

**Which machines to ask.** Codex's account-level read needs only one machine. Claude,
Antigravity and Grok are per-machine files holding that machine's own usage, so each
machine still has to report.

**Only if cross-machine deduplication stays.** Record lists exist to deduplicate native
files copied between machines (`docs/decisions/2026-09-01-federated-usage-metrics.md`),
but no vendor documentation read for this record describes syncing these files between
machines. Claude's local sessions stay local; its one copy path is an explicit
`--teleport` of a cloud session, which gives that terminal its own copy. Grok's shipped
docs describe none, and for Antigravity only unofficial forum posts were found, which
describe local-only history. A copy normally takes a manual step, such as a restored
backup or a migrated home directory, so #15252 accepts counting those twice. If #15031
keeps the record union for any provider, labels must travel with the records as
projection version 2, which `projection.json` pins:

```text
projection v2 = v1 fields + modelLabels: string[]          // sorted, unique, all used
claude record = v1 fields + model: <index> | <reason>
grok record   = v1 fields + incomplete: boolean
                          + model: [[<index>, input, output, cached, cacheCreation,
                                     reasoning, total, modelCalls], ...] | <reason>
```

`<reason>` is any reason above except `report-without-model-capability`, which only
describes a report with no such field. A refused record's tombstone carries
`model-missing`; its label is not retained.

**Label bounds.** Labels are ASCII, compared byte for byte, and never case-folded,
aliased or grouped by family. Vendor-routed forms stay separate buckets. The grammar,
at most 128 characters including any suffix, refuses paths, whitespace, `arn:`
identifiers, email shapes and digit-only values:

```text
^(?![Aa][Rr][Nn]:)(?=[^A-Za-z]*[A-Za-z])(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._:+-]*(?:@(?:[0-9]{8}|default))?$
```

The caps are guards against a malformed source, set far above real use, and tokens past
them stay in the provider total. A report holds at most 1024 distinct labels, keeping
the smallest and sending the rest to `model-label-limit`. A turn holds at most 256 rows.
Refused values never leave the reader. Validated labels may reach the peer-authenticated
report protocol and the owner's Usage page, and never logs or issues.

**Determinism.** Sort labels, rows and buckets by plain code-unit comparison, never
`localeCompare`, then hash with the existing `canonicalStringify` and SHA-256. Model
fields enter `evidenceHash` through `hashOf(providers)` only for v5 reports, so an
unchanged source still re-hashes equal and v1 to v4 hashes do not move. The corpus pins
`portos-native-model-attribution/1` over each scenario's sorted outcomes as a
cross-machine check; it is a test digest, not a new report field.

## Compatibility

- v1 to v4 reports stay parseable by their unchanged schema arms. Their tokens are
  `report-without-model-capability`, with totals unchanged.
- A copy from an old report adds no evidence and no tokens beside a new copy of the
  same identity.
- `scripts/lib/nativeUsageSources.js` requires exactly `contractVersion` 4, so the
  standalone capture stays v4. `/api/usage/native-report/v1` keeps answering v4 with
  model fields absent, `/v2` answers v5, and a collector falls back to `/v1` on 404, or
  on 403 from an older peer whose password gate refuses the unknown path.
- Staged partitions keep their recorded report versions and are not rewritten to gain
  labels. `attribution: 'excluded'` keeps meaning PortOS run linkage and is unrelated.

## Corpus

`server/lib/fixtures/nativeUsageModelAttribution/v1/` holds `contract.json` (grammar,
limits, vocabulary), `claude.json` and `grok.json` (raw-shape synthetic inputs with
hand-authored outcomes), `aggregate.json` (the peer rollup) and `projection.json` (the
record form). `server/lib/nativeUsageModelAttribution.fixtures.test.js` resolves every
scenario in every copy order, proves the buckets partition the provider total, and rolls
each outcome up into a valid peer block. It imports no native usage module, so it cannot
constrain the active #15031 work.

`server/services/nativeUsageAttribution.test.js` writes each scenario to a temporary
home and compares the production readers' rollups with the hand-authored outcomes.
`server/lib/nativeUsageRollups.test.js` runs `aggregate.json` through the production
refusal check. Scenarios mixing report capabilities describe a union across machines,
which the Usage view no longer performs, so only the reference resolver covers them.
`server/services/nativeUsageCollection.test.js` collects each scenario's copies in
separate runs, as #15255 requires, and checks that the stored report equals one full read.

## Handoff

#15252 extended the readers, contract, transport and Usage presentation for rollups.
If #15031 keeps a record union, these still need projection v2:

- **Projections and unions:** `server/lib/nativeUsageRecords.js`,
  `server/lib/nativeGrokUsageRecords.js`
- **Staging:** `server/lib/nativeUsageStaging.js`, `scripts/lib/nativeUsageSources.js`

Unresolved source limitations:

- No subscription-level token history for Claude, Antigravity or Grok was found in the
  code or in the vendor docs read for this record, though that search was not exhaustive.
  `grok usage` without a session reports a plan limit rather than token history.
- Claude cloud sessions run on Anthropic's infrastructure and count against the plan,
  but the docs do not put them in a machine's transcripts unless teleported. Retained-file
  totals can therefore undercount an account. This was not tested.
- Overlap between real machines was not measured. On one install, 32 of 33,709 Claude
  identities repeated across files, all among subagent files in one project.
- Neither retained format is a vendor contract. A format change must fail closed to
  `unknown` or `unallocated` while the provider total survives.
- No multi-model Grok turn was observed in `usage.json`. The split rule rests on the
  vendor's headless description and shared field names, enforced by exact reconciliation.
- `primaryModelId` has no defined meaning. It stays unread.
- `cacheCreationTokens` was always zero, so its relation to input is unverified.
- Grok's vendor text says session totals may include inherited history. The retained
  forks showed no turn repeated under another session, but the sample was two forks. A
  fork that copies turns under a new `sessionId` would be counted twice by today's
  identity, with or without models.
- Compaction and side-model calls are absent from Grok's per-model rows, so model buckets
  describe recorded usage only.
