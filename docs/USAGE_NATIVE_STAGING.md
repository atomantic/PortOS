# Offline native usage staging

This is the isolated staging increment of #15031, built on the provider/account
contract from #15097. It does **not** replace active accounting, register a cutover
runtime, acquire a barrier, change settings or peer sync, restart, or deploy.
The [cutover barrier](./USAGE_CUTOVER_BARRIER.md) continues refusing activation
with `local-runtime-not-ready`.

## Inputs and account scope

Capture each participant with `node scripts/native-usage-report.js capture` as
described in the [native projection plan](./plans/2026-11-06-native-usage-projection.md).
Keep the reports private: hashed record identities are linkable pseudonyms.
The staging command reads only files explicitly supplied to it, not native source
roots, the running server, credentials, local settings, or peers.

Prepare a separate request file with the complete expected participant set and
the existing account-selection contract:

```json
{
  "version": 1,
  "participants": ["<32-hex-participant-key>"],
  "selections": [
    {
      "family": "codex",
      "accountLabel": "acct-a",
      "members": ["<32-hex-participant-key>"],
      "authoritativeParticipant": "<32-hex-participant-key>"
    },
    {
      "family": "claude",
      "accountLabel": "acct-a",
      "members": ["<32-hex-participant-key>"],
      "historyScope": "operator-confirmed-retained-history"
    }
  ]
}
```

Use equivalent retained-history selections for `grok` and `agy`. Shared current
sign-ins do not establish historical account membership. The operator must
resolve mixed-account retained files before selecting them. A selection is bound
into this artifact only; staging never saves it in an instance's settings.

Every expected participant must supply an intact report, including non-authoritative
Codex members. Reports from extra participants, unknown identities, unresolved
account membership, cross-account copied records, conflicting captures and detected
Codex account/history changes refuse the stage. A missing source, failed read,
unreadable/invalid/skipped input, scan cap or truncated projection also refuses it.
There is no fallback to a stale stage, a different account authority, or zero.

When multiple captures of one participant contain different retained-record
projections, staging refuses with `<family>-retained-source-revised`. A latest-only
merge could otherwise hide an older conflict or copied identity. Resolve the
source revision and deliberately choose a new capture set; it produces a new
stage and never mutates a previous one. Unchanged duplicate captures are harmless.

## Stage and verify

Choose a private, isolated output directory outside active PortOS data:

```bash
node scripts/native-usage-stage.js stage request.json /private/staging host-a.json host-b.json host-c.json
node scripts/native-usage-stage.js verify /private/staging/native-usage-stage-<hash>.json
```

The first command writes one content-addressed JSON artifact and prints a short
receipt. It validates all input before creating output. Complete bytes are
published without replacing an existing file; identical retries and concurrent
completions return the same artifact. Incomplete temporary files are not stages.
An existing file with different bytes is refused, never repaired or overwritten.
New directories use mode `0700` and artifact files `0600` where supported.

Verification rebuilds the entire artifact from its embedded reports and request.
Changing counters, selections, manifests, partition hashes or the activation flag
fails verification. Hashes detect changes, not authenticity: retain trusted capture
provenance and do not treat a hash as proof of an account or source's completeness.

## Artifact contract, version 1

- `inputs` retains the strict participant reports, including excluded identities,
  conflict tombstones and earlier compared captures, plus the normalized request.
- `partitions` contains one entry per selected provider/account. Codex uses one
  authoritative snapshot. Claude, Grok and Antigravity union validated native
  identities, not machine totals. Conflicts remain excluded and counted, with the
  original evidence retained. No total is summed across providers.
- Each partition includes the source/schema/runtime versions, capture time,
  freshness, date boundaries, coverage and known missing intervals. Missing days
  are not filled with zero. Retained-record timestamps are not billing-day proof.
- The manifest binds every input report hash, selection and partition hash, the
  complete participant set, the report contract version and staging implementation
  version. Report hashes keep the report contract's algorithm; stage and partition
  hashes are SHA-256 of canonical JSON including its final newline, before adding
  that object's `contentHash` field.
- Legacy data is `preserve-separately`, with unknown overlap and no additive
  adjustment. Unselected providers are named explicitly. This records preservation
  requirements; it is **not** a legacy backup and does not read or copy the ledger.

`partial` retained coverage can be staged when the input scan is usable; this
means only the validated retained subset, never complete historical recovery.
Unfinalized/missing-field records remain excluded. Antigravity App/IDE containers
and legacy-only history remain unverified coverage, and its combined token total
remains unknown. Grok cost ticks retain their unverified units and billing scope.
Actual spend and API-equivalent USD stay unknown for all providers.

## Still required before cutover

The [offline barrier-store rehearsal](./USAGE_NATIVE_REHEARSAL.md) can now bind
detached ledger/peer-store copies to this stage and verify isolated byte restores
for every participant. Its read-only `snapshot-preflight` command also checks an
explicit detached standard snapshot against the bound stores and mandatory SQL
dump, while reporting present/absent inventory coverage. Neither establishes full
source preservation, matched-runtime/database restore or green cutover preflight.
The same rehearsal CLI can preserve explicitly supplied detached native roots and
replay their retained-provider entries against one exact embedded report. This
verifies only those supplied bytes and directory topology, not live inventory,
deleted history or Codex account-history replay. Unknown required roles cannot
produce a successful replay verdict. Global recovery and activation holds remain.

Every artifact permanently reports `activation.ready: false`. There is no activate
command, runtime registration, background task or boot migration in this increment.

#15031 still owns compatible partition readers/writers and continued refresh,
machine-local billing exclusions, per-instance consistent backups and isolated
restore receipts, a verified all-participant barrier, and matched-code rollback.
Inputs must be recaptured and validated at cutover. In particular, the barrier's
retained-write interval must be covered by native evidence or recorded as an
explicit gap; a stage captured before fencing cannot prove that interval is covered.
The partial account artifacts do not settle those gates or close #15031.
