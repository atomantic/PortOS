# Eidoverse discovery and world controllers

Observation-first discovery and executable world controllers. Part of the [Eidoverse Worlds integration](./eidoverse.md); travel is in [eidoverse-guest-travel.md](./eidoverse-guest-travel.md).

## Observation-first discovery (#7457)

SwarmWorld's finding is that reuse between agents starts by **looking at the
world**, not by asking its author about it. PortOS's mind tools grew the other
way round: a mind could speak (`eidoverse.say`), travel (`eidoverse.visit`) and
chat (`eidoverse.chat`, `eidoverse.visit-chat`) long before it could see what
was already standing in its own Commons. The continuous-play playbook has told
it to "move through the world and map what already exists" since that loop
landed — naming places, projections and affordances it had no tool to read.

`eidoverse.observe` is that missing read, and the playbook now leads with it.

### What it answers

One mind-scoped call (`manageEidoverse`, the same grant as the foundation and
controller reads it summarizes) returns:

- **`places`** — the eight districts as somewhere a mind can stand and
  describe: label, direction, landmark, which signal sources feed it, how many
  live signals those sources currently report, and whether any of them want
  attention. Districts come from the install's **resolved design recipe**, not
  from a constant, so a mind never names a district a later design version
  renamed (V3 calls it the Federation Terminal, not the V2 Harbor) or one the
  user's own overrides moved. A source the recipe has switched off reports as
  `disabled` rather than counted — the projection places nothing for it.
- **`peers`** — the opaque travel ids `eidoverse.destinations` also returns, so
  one carries straight into `eidoverse.visit` — each with **how many
  foundations this install inherited through it**.
- **`foundations.inherited`** — a peer's contributions, newest first, with the
  peer they arrived through and the instance that authored them (distinct on
  purpose: a multi-hop re-share is only legible when they are).
- **`controllers.needsAttention`** — only installs that are disarmed or
  failing. A controller that has never ticked yet is one interval away from its
  first tick, which is normal, not an alarm.
- **`changes`** — what is new since this mind last observed.

That third bullet is the epic's acceptance criterion: **a peer contribution is
discoverable by touring the Commons**, because the Federation Terminal chamber
carries the count and the inherited list names the build — no repository read
and no conversation with its author required.

### Three distinctions the report refuses to collapse

- **Unavailable is not empty.** A district whose source failed to read reports
  `signalCount: null` and `status: 'unknown'`, never `0`/`quiet`. Reporting an
  unreadable app list as "the terraces are empty" is the same misreport #7458
  fixed for district density, and it would be worse here, where the mind acts
  on it.
- **`signalCount` counts signals, not placed entities.** The projection
  allocates a capped, round-robin sample of live signals into the world, so the
  world may hold fewer. Counting sources keeps the tour readable **without a
  running world runtime** — a mind that cannot start the runtime still needs to
  know what is in its Commons — and the field name says "signals" so the
  difference is never implied away.
- **Never-observed is not nothing-new.** A first observation reports
  `firstObservation: true` with no new items rather than handing a mind waking
  into a months-old install its entire world as "new".
- **A section that failed to collect is not an empty section.** It arrives as
  `null`, contributes no changes, and **carries the previous marker's ids
  forward**. Collapsing it to `[]` would report every peer as departed on a
  transient read failure, rewrite the marker without them, and then report them
  all as new on the next observation — a flap that repeats for as long as the
  source keeps failing intermittently.

### Local attention reasons

Each place includes `attentionSignals` and `attentionTruncated`. Contributors
identify the enabled, successfully read `source`, its actual `severity`
(`attention` or `error`), its contributing `signalCount` (rows), and `reasons`.
The district's total `signalCount` includes healthy rows and is not a fault count.
An app group is one signal row even when it represents many applications.
Each reason contains an allowlisted `code` and `affectedCount`, an aggregate
number of affected records when known, otherwise `null`.

Use `app_not_started`, `app_stopped`, and `app_unknown` to distinguish registry
conditions before choosing a process diagnostic; not-started is not proof of a
crash. Nexus can report `runtime_data_disk_pressure` or
`runtime_data_disk_critical` (capacity of the filesystem holding runtime data),
`memory_pressure` or `memory_critical`, `backup_failure`, `review_alerts`, and
`cos_paused`. These come from the same predicates that determine source status;
health does not alarm on not-started apps, while App Arcade does.

Agent Foundry task errors mean **blocked internal CoS queue entries**, not
necessarily failed executions. `task_user_terminated` means the entry records
intentional user termination; `task_blocked` covers every other block category,
including absent or unknown categories. Each task row represents one entry, so
these reason counts aggregate entries. Recorded user intent does not authorize
retrying, restarting or mutating stopped work. Ordinary pending work stays
steady, approval-gated and challenged work stays attention, in-progress work
stays active, and terminal entries are excluded. No task names, raw block
reasons or arbitrary category strings enter the observation.

Federation Terminal counts errored peer records with structured failed-probe
reasons: `peer_connection_refused`, `peer_transport_failure`, `peer_probe_timeout`,
`peer_auth_required`, `peer_dns_failure`, `peer_host_unreachable`, and
`peer_health_http_failure`. Use these to select a bounded connection or credential
diagnostic, without retrying peers or changing admission. `peer_failure_unknown`
means the errored peer has no recognized failed-probe evidence (including legacy
records); neither `status:error` nor unavailable travel proves a configuration,
guest-admission or sync failure. Successful/healthy peers ignore old failure
metadata. Probe messages, HTTP response bodies and network identities stay private.

Other sources and older reason-less inputs use `source_attention` or `source_error`: these
say only that a coarse source status requires attention, without inventing a
cause. Error sources remain identifiable even though district status is attention.

Reasons are ordered by source, severity (error first), then code and capped at
24 entries per district. `attentionTruncated: true` means some entries were
omitted. Healthy recovery removes reasons on the next collection; disabled and
unreadable sources emit none, and unavailable inputs never reuse previous causes.
Diagnostics contain no app names, record identities, paths or raw errors. They
are collected only for local observation under the existing mind
`manageEidoverse` grant, without new routes, grants, world logs, renderer
payloads or peer exports. A subsequent observe still advances the visit marker;
use the internal `commit: false` form to inspect without consuming its delta.

### The visit marker

"What is new since I last looked" has to cross a **wake boundary**: a mind
wakes, observes, acts, and ends its turn, and the next wake is a different
process. Nothing in-memory survives that. The world chat cursor lives in a
100-entry ring buffer a restart empties; the peer sync's `lastOfferingListHash`
is per-peer content-change detection for a background sweep, also in memory.

So observing **stamps a marker** — `data/eidoverse/observation.json`, covered
in [STORAGE.md](../STORAGE.md). That is the stigmergic half of the slice: the
trail a mind leaves is what makes the next observation's `changes` mean
anything. It also means `eidoverse.observe` is **not idempotent**, and that it
is declared `sideEffect: 'write'` even though a mind reads it like a read.
That is not a label: `mindToolRecipes.js` only lets a saved recipe compose
`'read'` tools, and the MCP bridge exports `readOnlyHint: sideEffect ===
'read'`. Calling a marker-stamping tool a read would let a replayable recipe
silently consume the `changes` delta the playbook depends on, and would tell an
external MCP client the tool touches nothing.
`observeEidoverseWorld({ commit: false })` is the internal look-without-stamping
form.

The marker holds ids, per-district status, and a timestamp — no body, no style,
no record content — and is machine-local like the ledger and the controller
store beside it. A marker written by a newer PortOS degrades to one honest
`firstObservation` rather than being diffed against fields this build does not
understand, and an *unreadable* marker file throws rather than reading as
never-observed, because the next write would otherwise replace a real marker
and re-report a settled world.

### Signal, not noise

Two filters keep `changes` worth reading on a busy install:

- **Places diff on a status flip, never on a count change.** Signal counts move
  every wake as agents and tasks come and go; diffing them would make `changes`
  pure churn. The live count stays in `places` for a mind that wants it.
- **A controller already wanting attention last visit is not re-reported.** A
  long-broken controller would otherwise re-alarm every wake and drown the one
  that just broke.

### Where it lives

`server/lib/eidoverseObservation.js` is pure: `buildEidoverseObservation()`
takes already-collected snapshots plus the previous marker and returns
`{ report, marker }`, so the whole diff contract is testable without a world
runtime, a socket or a file. `server/services/eidoverseObservationLedger.js` is
the I/O, clock and marker shell around it — and every collection failure
degrades that section to `null` rather than failing the tour, because a mind
that cannot read its controllers should still get to see its districts.


## Executable world controllers (#7456)

SwarmWorld's strongest result is that technologies are *executable*: they keep
running once the agent that authored them is gone. PortOS minds wake
intermittently, so a world that only changes during a mind turn is a world that
is dead most of the time. A **controller** is the durable thing that keeps
running between wakes — a resource tick, an ambient verb, a gentle NPC, a
maintenance hook — supervised by PortOS rather than by whoever installed it.

**Behavior is code PortOS ships; an install is data a mind authors.** The only
thing an install may say about behavior is a `controllerId`, resolved by
`server/services/eidoverseControllerRegistry.js` against a fixed directory of
shipped modules. There is deliberately no path-taking export on that resolver at
all: an install arrives from an HTTP body or a mind's tool call, and "import the
module this request names" is arbitrary code execution wearing a feature's
clothes. This is the same rule the resilience-assay contribution registry
already applies, for the same reason.

**A tick cannot reach an AI provider.** `runControllerStep`
(`server/lib/eidoverseControllers.js`) refuses a step that returns a Promise, so
there is no await for a network, disk, or provider call to hide behind. Root
`AGENTS.md`'s "no cold-bootstrap LLM calls" rule is therefore a structural
property of the tick path rather than a convention — boot arms a timer and
nothing else. The same synchronous rule is why every shipped controller is
replayable by the agent-free assay with no extra authoring: the controller
registry is both the assay CLI's second contribution source and what a
`controller` foundation's promote gate resolves `body.controller.definitionId`
against — replaying the definition against **this install's own config**, so the
evidence is about the controller this install actually configured.

**Effects are proposals, from a closed vocabulary.** A step returns effects, it
does not perform them — the same proposal-versus-consequence separation the
construction tools have. `note` never leaves the ledger; `say` and `augment`
reach the world only for an install whose `deliverEffects` was explicitly turned
on (it defaults to `false`), and `augment` reuses the existing world-verb
operation schema rather than inventing a second one. A delivery that fails is
recorded and the step still counts: the controller's own state advanced, and
re-running it to retry a world write would double-count everything it did.

**Supervision.** `server/services/eidoverseControllerRuntime.js` registers one
`eidoverse-controller-tick` interval with the event scheduler and steps every
install whose own cadence is due. Arming is reconciled at every gate move —
install, retire, arm/disarm — and not only at boot, so a controller installed at
16:00 is not waiting for a restart to start ticking. A pass never replays a
backlog: a machine asleep for three days wakes to ONE tick, because a cadence is
"about this often", never a ledger of owed executions. A controller that fails
`maxConsecutiveFailures` ticks in a row is disarmed with a recorded reason rather
than retried forever, and an install whose `controllerId` this version no longer
ships is disarmed immediately.

**Every tick revalidates the stored install against its own definition
(#7629).** `record.config` is re-parsed through `definition.configSchema`
before each step rather than trusted from install time — a config that no
longer parses (a shipped schema tightened, a hand-edited file) disarms the
install immediately instead of stepping it, and a newly-added default lands on
the record the first time it re-parses cleanly. `definition.invariants` — the
same predicates the resilience assay replays — run against the state a step
just produced; a violation fails that step and counts toward
`maxConsecutiveFailures` like any other failure, so the live supervisor holds a
controller to the same contract the promote gate does. The store's own
`schemaVersion` stamp is read back (not assumed to be this build's constant):
a store written by a newer build disarms rather than stepping under rules it
does not fully understand — and the writes that disarm never re-stamp the file
with this build’s older constant, so the signal survives the pass that reads it
rather than being erased by it.

**Storage** is `data/eidoverse/controllers.json` — `file-primary` and machine
local, never federated (`docs/STORAGE.md`). A controller crosses to a peer only
as the *body* of a promoted foundation, which carries no install.

**Delivery evidence (#10818).** Both the common list and semantic inspect
projection expose nullable `lastCompletedDelivery: { at, tick, ok, delivered,
reason }`. It changes only after a `say` or `augment` delivery finishes and
still matches the installed record's latest tick. `at` is that tick's time;
read it and `tick` to assess the age of the acknowledgement. A refusal (including
partial delivery) or thrown error replaces prior success. Quiet ticks, local
notes, disabled delivery, step failures and in-flight requests leave the prior
completed verdict intact. Arming/config edits preserve it; reinstall resets it.

`lastDelivery` retains its latest-tick contract: quiet ticks report unknown
(`ok: null`). Neither historical acknowledgement nor pulse/failure counters or
`recentEffects` proposals prove current world state or visible rendering.
Migration 425 upgrades older stores to schema version 2 with unknown (`null`)
completed history, preserving their state and counters rather than manufacturing
success from ambiguous old outcomes. There is no shipped store seed.

**Shipped controllers.** `ambient-beacon` counts ticks and marks a pulse every
Nth one (`announce` decides whether that pulse is spoken into the world or kept
as a note). `lantern-keeper` re-issues the `light` verb for a fixed set of world
entities every Nth tick, so lamps an author placed stay lit across host restarts
while the author is away — re-lighting an already-lit lamp is a no-op, which is
what makes running it on a schedule safe.

**Explicit riddle rounds.** `riddle-ledger` implements a fixed offer → guess →
reveal interaction. It evaluates no foundation body: schema/affordance
foundations remain declarative, with their body, attribution, admission and
promotion contracts intact. Install a separate controller explicitly with an
unused id, `controllerId: "riddle-ledger"`, `config: {}`, `armed: true`, and
`deliverEffects: true` to speak into the private world (false for local-only
play). Nothing installs at boot or resets another controller. Supervised ticks
are silent, including after restart.

Read `GET /api/eidoverse/world/controllers/<id>` or
`eidoverse.inspect-controller`, then send `POST
/api/eidoverse/world/controllers/<id>/riddle` or the `eidoverse.riddle` tool:

```json
{"action":"offer","expectedRevision":0,"clue":"Which shape has three sides?","answer":"triangle"}
{"action":"guess","expectedRevision":1,"guess":"TRIANGLE"}
{"action":"reveal","expectedRevision":2}
```

The tool also takes `id`. Both mind grants (`manageEidoverse` and
`installEidoverseControllers`) are required. HTTP gameplay uses the operator
gate, including authenticated local-agent sessions; scoped peer credentials do
not grant gameplay. Each request must use the inspected `state.revision`, which
advances once per accepted action. A stale revision, a second guess, a repeated
reveal, an offer before revealing the current round, or a disarmed/wrong-kind
install refuses without changing state or sending chat. Revealing without a
guess is allowed; its `correct` is null. Otherwise matching ignores case after
input trimming, and correctness is withheld until reveal.

`outcome: "applied"` means the local transition persisted, even if world
delivery failed. Inspect `state.delivery` (also returned as `delivery`):
`disabled` means local-only, `pending` means completion is unknown,
`acknowledged` means the existing world `say` protocol acknowledged one message,
and `refused` carries the failure reason and acknowledged count. The answer is
only spoken on reveal; private operator inspection includes it throughout.
World acknowledgement does not prove visible browser rendering. Progress lands
before delivery; neither a restart nor a repeated request retries the message.
A crash can leave `pending` evidence, which must not be called successful.
If a management operation replaces/retires the install during delivery,
`outcome: "superseded"` reports the receipt without attaching it to the
replacement. Round state lives entirely in the existing machine-local controller
store, never in a promoted foundation or federation envelope. This surface is
API/tool gameplay; it adds no world-client command or guest interaction UI.

**The mind needs its own grant to install.** `eidoverse.install-controller` and
`eidoverse.retire-controller` are gated on `manageEidoverse` **and** the separate
default-off `installEidoverseControllers` grant, and are mind-scope only:
building in the world during a turn is a different act from leaving something
running in it afterwards. The reads beside them, `eidoverse.controllers` and
`eidoverse.inspect-controller`, need only `manageEidoverse` — a mind that can
build should be able to see what is already ticking, and seeing is what makes
the writes usable rather than guesswork. `eidoverse.controllers` never carries
`config`/`state` (`summarizeControllerInstall`'s LIST projection); a caller that
wants one install's config and accumulated state back reads
`eidoverse.inspect-controller`, backed by the same `GET
/api/eidoverse/world/controllers/:id` the panel's Details view uses (#7629).

**Changing a config without losing state.** Re-installing an existing id
rebuilds its state from the new config from scratch — the deliberate behavior
for "I want this to start over." `updateEidoverseControllerConfig` (routed at
`PATCH /api/eidoverse/world/controllers/:id/config`) is the other verb: it
re-parses the new config through the definition's own schema and leaves
`state` untouched, for a later mind that wants to tune a value on a controller
it inherited without destroying what it has already accumulated.
