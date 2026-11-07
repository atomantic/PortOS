# Usage cutover barrier

The barrier stops old accounting state from re-entering while a usage partition is
replaced, across every instance taking part, without pausing any other sync. It is the
category-specific barrier required by the
[native usage projection plan](./plans/2026-11-06-native-usage-projection.md).

This is the barrier only. Staging a rebuilt partition, backup and restore rehearsal,
maintenance coordination and the live cutover belong to #15031. Nothing acquires a
barrier at boot or on upgrade, and no migration touches one.

The main sync switch cannot do this job. `usage` is on by default, `syncEnabled: false`
leaves default-on categories active, `fullSync` overrides the category map, and digests
are forwarded through third peers. The barrier is evaluated after all of that, at the
points where usage state is written and applied.

## States

| State | Live run writes | Backfills and resets | Inbound digests | Outbound digests |
|---|---|---|---|---|
| `idle` | Written | Written | Unstamped only | Unchanged wire |
| `fencing` | Retained | Refused | Refused | Withheld |
| `fenced` | Retained | Refused | Refused | Withheld |
| `activated` | Written | Refused | This epoch, from participants | Stamped |
| `rolling-back` | Retained | Refused | Refused | Withheld |

An `activated` record on code that does not declare that epoch's runtime behaves as
fenced, as does an unreadable record. Restarting never lifts a fence, because the record
is read from `data/usage-cutover-barrier.json` at every gate.

**Retained** writes are durably held in the barrier record and answered with
`{ deferred: true }`. They are real money data with no other durable home.

- On release they replay into the proven restored ledger, each exactly once and on the day
  it happened. The replay
  marker commits in the same write as each record, so a crash mid-replay is safe to retry.
- On activation they stay retained and are not replayed, because they were recorded
  against old accounting and the rebuilt partition must not absorb them. Status reports
  their count and interval. #15031 decides how the rebuild accounts for that interval.

**Refused** writes throw `409 USAGE_CUTOVER_FENCED`. Their callers have not advanced a
watermark, so they recompute from native sources on the next attempt.

## Inventory

### Writers

| Writer | Reaches the ledger through | During a fence |
|---|---|---|
| Run sessions (`bootstrap.js`, `agentRunTracking.js`, `POST /api/usage/session`) | `recordSession` | Retained |
| Completed run accounting (`usageReconciler.js`, `aiProvider.js`) | `recordRunUsage` | Retained; retained Codex claims still count against later runs |
| Client counters (`POST /api/usage/messages`, `/tokens`) | `recordMessages`, `recordTokens` | Retained |
| Limit blocks (`promptRunner.js`, `providerStatus.js`) | `recordLimitBlock` | Retained |
| Live media (`grokMediaUsage.js`, `agyMediaUsage.js`) | `addDatedUsage` | Retained; repair ids keep it idempotent |
| Native history refresh (`nativeUsageHistory.js`) | Its own per-app stores, not the ledger | Skipped; the app files stay on disk, so the next refresh catches up |
| Historical backfill (`usageBackfill.js`) | `applyHistoricalUsageCorrections` | Refused; the job ends in error naming the fence |
| Grok and Antigravity repair (`grokUsageBackfill.js`, `agyUsageBackfill.js`, `scripts/backfill-*`) | `addDatedUsageBatch` | Refused, including from a separate CLI process |
| Reset (`DELETE /api/usage`) | `resetUsage` | Refused |
| Other ledger commands | `markUsageRunReconciled`, `flushUsageLedger` | Refused |
| Load normalization at boot | `loadUsage` | Loads in memory without writing |
| Reports reading fleet usage | `versionSelfProjection` in `peerUsage.js` | Serves the read without writing |
| Removing a peer | `forgetInstanceUsage` | Deferred and applied when the fence lifts |
| Claude transcript store (`claudeCodeTranscriptUsage.js`) | `refreshLocalTranscriptUsage` | Skipped; the next refresh catches up from native files |

Every ledger writer passes one boundary, `mutateUsage` in `usage.js`, and the decision
runs inside its queue. A write queued before the fence is decided by the gate; one
already running is what the drain waits for.

These are deliberately not fenced:

- **Image render receipts** (`imageRenderUsage.js`) are immutable, content-addressed
  files deduplicated by id, and are never summed into the ledger. Peers cannot see new
  ones during a fence because outbound digests are withheld.
- **Quota readings** (`providerQuotaShare.js`) are meter readings, not counters.
- **`data/fleet-host-usage.json`, `data/cos/domain-usage.json` and the media usage index**
  are not part of this accounting and never federate through `usage`.
- **Migrations** (`scripts/migrations/`) run only at boot on an upgrade, before the server
  serves anything. A migration changing `usage.json` under a fence changes its fingerprint,
  so release refuses until the matched backup is restored.

### Sync paths

| Path | Gate |
|---|---|
| Periodic, `peer:online` and manual pulls (`syncOrchestrator.js`), direct or forwarded | `admitInboundUsage` inside the peer-digest lock in `applyUsageRemote` |
| `POST /api/sync/:category/apply` for `usage` | The same gate |
| `GET /api/sync/usage/{checksum,manifest,snapshot}` | `describeOutboundUsage` in `peerUsage.js` |
| Forwarded digests held in `peer-usage.json` | Filtered by epoch on the one read path, `entriesWithSelf`, for reports and the wire alike |
| Queued or delayed payloads | Judged against current state inside the lock, never a captured one |
| Full sync and reciprocal sync | Resolve the category map only, so they reach the same gates |

A refused payload is not treated as converged, so its checksum is not cached and the
digest is pulled again once the fence lifts. Other categories run through the same
transport untouched.

During a barrier `instances` on the wire is empty and any epoch data travels inside a
`cutover` stamp `{ migrationEpoch, state, barrierSchema, instances }`. An older runtime
therefore sees nothing it could merge into old accounting. With no barrier the wire is
exactly what it was.

## Procedure

Run each action on every participating instance, on that instance. They require host
control: an operator session, a `PORTOS_API_TOKEN` agent session, or a local connection
on a password-free install. Peers cannot trigger them. Use `node scripts/portos-api.js`
from a terminal session, or the routes below.

### 1. Acquire

```bash
POST /api/usage/cutover/acquire
{ "migrationEpoch": "native-2026-11", "participants": ["<instance-id>", "<instance-id>"] }
```

Fences this instance and drains started work. Participants are the `instanceId` of every
instance taking part, including this one. Retrying the same epoch and set resumes an
interrupted drain.

Refused when:

- the epoch or participants are malformed (`400`);
- this instance has no federation identity yet, or is not in the set;
- a different barrier holds this instance (`USAGE_CUTOVER_BUSY`);
- the epoch was already retired here (`USAGE_CUTOVER_EPOCH_RETIRED`). Choose a new name.

### 2. Back up and stage

After every instance reports `fenced`, take the backups described in the plan. Status
reports `fingerprints`, the SHA-256 of `usage.json` and `peer-usage.json` bound at fence
time. Record them with the backup: release requires those same bytes back.

### 3. Verify

```bash
POST /api/usage/cutover/verify
{ "migrationEpoch": "native-2026-11" }
```

Reads every participant's acknowledgment at `GET /api/sync/usage/cutover` and records why
cutover is held. A participant with no direct route can be learned through a participant
that has one, so in a chain verify the middle instance first. An empty `holdReasons`
means activation may proceed.

| Hold reason | Meaning | Resolve by |
|---|---|---|
| `participant-offline:<id>` | No response | Bring it online |
| `participant-no-route:<id>` | No direct peer record and no relayed acknowledgment | Verify on an instance that can reach it first |
| `participant-old-runtime:<id>` | It serves no barrier protocol | Upgrade it |
| `participant-schema-mismatch:<id>` | Different barrier protocol version | Match versions |
| `participant-refused:<id>` | Its pull authorization refused this instance | Enable `usage` for this instance there |
| `participant-wrong-instance:<id>` | That address answered as a different instance | Fix the peer record |
| `participant-epoch-mismatch:<id>` | No barrier, or a different epoch | Acquire there |
| `participant-set-mismatch:<id>` | Different participant list | Re-acquire with the same list |
| `participant-not-fenced:<id>`, `participant-not-drained:<id>` | Not yet fenced | Retry acquire there |
| `participant-runtime-not-ready:<id>`, `local-runtime-not-ready` | Code does not declare this epoch's runtime | Deploy the runtime from #15031 |
| `peer-not-participant:<id>` | An enabled peer is outside the set, whatever its sync settings | Disable or remove the peer, or release and re-acquire with it in the set |
| `peer-unidentified:<name>` | An enabled peer has never been probed | Probe it or disable it |
| `unknown-origin:<id>` | A held digest comes from outside the set | Remove that peer to retire its digest, or release and re-acquire with it in the set |

### 4. Activate

```bash
POST /api/usage/cutover/activate
{ "migrationEpoch": "native-2026-11" }
```

Verifies again, then resumes under the new epoch on this instance. **This release has no
such runtime, so activation is always refused with `local-runtime-not-ready`.** #15031
declares it with `registerUsageCutoverRuntime(epoch)` once the rebuilt partition exists.

Instances may activate one at a time. A fenced instance refuses an activated peer's
payload and an activated instance accepts only its own epoch, so accounting states never
mix in the window. After activation, payloads with no stamp, another epoch or another
barrier schema are refused, digests for origins outside the set are dropped, and old
digests stay on disk but out of reports and the wire. The new epoch is never summed into
old counters: each origin keeps its own slot and existing LWW and tombstones still apply
within the epoch.

Refused when any hold reason remains (`USAGE_CUTOVER_HELD`) or this instance is not
`fenced`. A later second epoch is not supported from `activated`.

### 5. Release, before activation

```bash
POST /api/usage/cutover/release
{ "migrationEpoch": "native-2026-11" }
```

Returns this instance to old accounting and replays retained writes. An offline
participant does not block this, because the epoch rules refuse both directions.

Refused when:

- a participant has already activated (`USAGE_CUTOVER_HELD`). Roll it back first;
- `usage.json` or `peer-usage.json` differ from the bytes bound at fence time
  (`USAGE_CUTOVER_RESTORE_REQUIRED`). Restore the matched backup first;
- this instance is still `fencing`. Retry acquire first.

### 6. Rollback, at any point after acquire

```bash
POST /api/usage/cutover/rollback
{ "migrationEpoch": "native-2026-11", "reason": "Totals did not match" }
```

Re-fences this instance and keeps the barrier until the matched rollback is complete.
An activated participant that sees this state in a payload holds itself the same way,
so peers stop applying new payloads without an operator race. Run rollback on every
participant regardless, then:

1. Restore each instance's matched backup and previous code and schema together. The
   target code must be this release or later: older code cannot read a barrier. A backup
   restore never installs `usage-cutover-barrier.json`, so it cannot lift the fence.
2. Run `verify` on each instance until no participant is reported as not rolling back.
   A release needs every participant `rolling-back`, or already released from this epoch.
3. Run `release` on each instance, as in step 5.

Release from `rolling-back` is also refused while any participant has not rolled back or
is unreachable and was never seen rolling back. On success the epoch is retired on that
instance permanently: payloads still stamped with it stay refused, and its name cannot be
acquired again. Retained writes replay once, so totals are the restored backup plus those
writes, never the rebuilt partition's. Writes made to the ledger while `activated` are
discarded by the restore; their native sources remain for the next backfill.

## Status

`GET /api/usage/cutover` is read-only and contacts no peer. It reports `state`,
`migrationEpoch`, `participants` with each last acknowledgment, `holdReasons`,
`verifiedAt`, the transition times, `rollback`, `fingerprints`, `retiredEpochs`, `writersHeld` and
`outstanding`: in-flight work per writer, retained write count and interval, and deferred
retirements. It never exposes retained records. A damaged record reports `unreadable`
with the hold reason `barrier-unreadable`, stays fenced, and refuses every action until
the file is repaired from a copy.

## Compatibility

`PORTOS_SCHEMA_VERSIONS.usageCutover` versions the stamp and acknowledgment. It is compared
only by this gate and is not part of the `usage` snapshot schema gate, so an older peer
keeps syncing while no barrier is active. A peer on an older runtime answers `404` for the
acknowledgment, which holds activation.
