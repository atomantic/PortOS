# Peer administration planning (draft)

This draft is a **dependency foundation, not executable remote administration**.
Every advertised action reports `executionSupported: false`. A valid plan stays
`state: planned`, `queued: false`, `inFlight: false`. It cannot update, restart,
download, install, cancel active work, or become a queued operation after an
upgrade. No executor, shell command or maintenance override is wired here.

The fixed vocabulary is `portos.update`, `portos.restart`, and
`catalog.install`. Update/restart have no user-provided arguments. Catalog plans
accept only a shipped catalog key and `ollama` or `lmstudio`; free-form model IDs,
URLs, filesystem paths, code recipes, tokens, force flags and license-acceptance
flags are rejected. Gated models and Ollama import recipes require local setup
and cannot be planned through this surface. No terms are accepted by a plan.

## Later operator setup

Nothing is granted by installation, discovery, pairing, sync opt-in, this PR,
or an instance's display name. No migration creates permission or credentials.

1. On the **receiving host**, use an operator session (including its existing
   delegated agent session), or a local connection on a password-free install.
   Enable and pair the known peer using the existing pairing workflow.
2. Open Instances → the peer → **Peer administration · planning only**. Compare
   the receiving host UUID and paired caller UUID. These IDs, the existing pair
   credential binding, and the exact action define authority; names do not.
3. Review a specific grant, then explicitly allow planning for one hour. The API
   supports one minute to 24 hours. The API/UI returns a grant ID and timestamps.
   This is `planning-v1`, not permission to execute. A future execution protocol
   must require another explicit operator grant with a different scope.
4. On the sending host, an operator can preview update/restart requirements.
   The peer must separately have granted that sender planning access. Catalog
   plans are API-only until source/license/destination review is available.
5. Revoke an action on the receiving host at any time. Revocation and renewal
   rotate its grant ID; existing preflights/plans immediately become unusable.
   Expiry, disabled/deleted peers, identity changes and pair-secret rotation
   deny access. Disabling suspends the grant; use Revoke to permanently remove
   its permission. Re-enabling cannot extend its original expiry.

Grant writes compare the prior grant ID to prevent stale browser saves from
resurrecting revoked permission. Setup is always behind `requireHostControl`;
that gate and existing update, restart, model, settings and socket routes retain
their original authority rules. There is no instance-password or Basic fallback
on this protocol. Operator credentials are never forwarded to the peer.

## Protocol and audit identity

Exact POST routes under `/api/federation/admin/v1/` are `preflight`, `plans`,
`receipt`, and `execute`. Every route requires the current verified paired
credential even when the optional instance password is off. The global gate
only admits these exact paths; it does not give peers host-control authority.

- Preflight: `{ protocolVersion: 1, challenge: <uuid>, intent }`. The receiver
  validates the action grant and catalog entry, rechecks identity/grant after
  probes, and signs a snapshot with a domain-separated HMAC using the existing
  pair secret. It binds sender/receiver UUIDs, version, action, grant ID, unique
  preflight ID, challenge and a maximum 60-second expiry. The sender verifies
  that proof, target identity, version contract and freshness before planning.
- Plan: `{ protocolVersion: 1, requestId: <uuid>, preflightId, grantId, intent }`.
  The preflight is consumed once. An exact same-request retry returns the same
  signed receipt; changed payloads reusing a request ID are rejected. A new
  request ID cannot consume an already-used preflight. Reconciliation uses
  `receipt` with `{ requestId }`, authenticated and scoped to that peer.
- Execute: `{ requestId }` verifies ownership/current permission, then returns
  `503 PEER_ADMIN_EXECUTION_UNAVAILABLE`. It never responds with job acceptance
  or restart completion and never creates an operation.

Receipts contain server-derived sender/target UUIDs, request/preflight/grant IDs,
intent, timestamps, version and blockers. They are **temporary diagnostics, not
an execution audit ledger**: maximum 128 preflights and 128 plans per process,
60-second preflights, five-minute plans, additionally limited by grant expiry.
Expiry or process restart returns not-found/stale, never resumes work. Duplicate
preflight challenges within the live window are rejected. There is no eviction
of live receipts to make room. A future durable execution ledger must retain
idempotency/replay tombstones independently of these ephemeral previews.

The operator sender makes only an explicitly requested two-hop preview, with
one ten-second timeout, a 64 KiB response limit and no redirects. It sends only
existing pair credentials; network failures never cause automatic retries or
fallback to broad tokens. An unverifiable response is a refusal. Older peers
without this protocol remain usable for their existing federation surfaces.

## Required before execution can be enabled

- Wire the **coordinator-owned exclusive claim** into an authorized receiver
  executor after the remaining requirements below are complete. The internal
  primitive is implemented as described below; the planning protocol still
  cannot acquire it. `status().state === 'ready'` followed by execution remains
  unsafe; ordinary `admit` and a second independent lock are not substitutes.
  All admitted work must settle naturally; no interruption fallback.
- Implement a durable, receiver-local operation ledger and fixed adapters for
  the existing fork-aware PortOS update and PortOS-only restart. Recheck target
  identity/version/capability and permission at dispatch. Persist request and
  grant identity before launch. Distinguish queued, draining, in-flight,
  awaiting-reconnect, succeeded, failed and uncertain; request acceptance never
  proves restart or update completion. Reconcile the same operation after a
  crash, bound deadlines and expose typed errors. Retain the exclusive hold
  when side effects are uncertain; never retry a launch based only on timeout.
- Integrate the existing catalog source/license review and installer preflight
  for the exact receiver-side entry/backend. Verify actual destination disk
  capacity including staging/headroom, memory/runtime fit, installed runtime
  and reviewed source identity. Preserve local terms and code-review gates;
  unknown size/requirements, new terms, unknown code and changed catalogs deny.
  This draft reports only advisory data-volume/OS memory telemetry and explicit
  missing-check flags. It does **not** claim those are installation checks.
- Surface rollback only when an adapter supplies a verified supported recovery
  path; otherwise report manual recovery. Never offer generic git reset, shell,
  command, URL/path execution or deletion as rollback. Test grant revocation
  during drain, queued cancellation, dispatch races, crash reconciliation,
  durable replay rejection and no active-work interruption before enabling.

These are dependencies, not permission to operate any peer. Enabling grants,
credentials, live settings, machine updates/restarts and model downloads remains
a separate later operator action.

## Exclusive coordinator foundation (#10127, first slice)

The coordinator now owns `observeIdle`, `claimReady`, `getExclusive`,
`transitionExclusive` and `settleExclusive`. These are internal construction
APIs, with no HTTP claim or recovery route, execution grant writer or adapter.
Existing `planning-v1` grants, previews, receipts and execute refusal keep their
current behavior. The claim's required `execution-v1` binding describes the
future protocol; it neither creates nor verifies an execution grant today.

`observeIdle` mints an opaque, process-local observation after all tracked work
has settled. It is usable once, for at most five seconds, against the exact
journal revision and hold ID/revision. Copies, wire objects, other coordinator
instances' observations, backwards clock changes and intervening writes deny.
`claimReady` rechecks that evidence and the hold under the same cross-process
transaction used by admission and resume. A second claim or resume loses the
race without changing ownership. Readiness displays a blocker while claimed.

The bounded current ownership slot records the operation/request UUIDs, peer
and receiver UUIDs, grant ID/generation, execution scope, pair binding digest,
fixed intent, receiver version and preflight evidence digest. Its fingerprint
binds those fields; changing either identity or intent cannot reconcile another
operation. This is an ownership fence, not permission: the eventual receiver
must authenticate and recheck current grants, pairing, capability and resource
evidence before requesting a claim or recording a start.

A reservation needs another fresh observation before it can move to
`in-flight`. Start is durable **before** any future adapter side effect. From
there only `awaiting-reconnect` or `uncertain` transitions are allowed; timeout,
restart and reconnect never authorize another start. A newly observed survivor
after start moves the claim to uncertain and invalidates stale reconciliation.
No recovery kills or cancels that survivor.

Only an unstarted reservation may be cancelled. A started/uncertain claim needs
terminal persistence and cleanup evidence checked by a receiver-owned
synchronous verifier supplied when constructing the coordinator. The default
verifier denies every terminal release. Exact claim ID/revision/fingerprint
comparison prevents stale settlement from releasing changed ownership. An
interrupted publication retains the exclusive owner and fails closed. Settlement
leaves the operator hold in place; explicit resume can then restore prior
policies. The last settlement receipt makes its immediate replay idempotent;
it is **not** permanent request replay history or the execution audit ledger.

The remaining sequence stays owned by #10127, which this slice does not close:

1. Add the receiver-local Postgres operation ledger and permanent request
   idempotency/consumption records. Bind its operation identity and verified
   terminal receipt to this coordinator slot; reconcile journal/DB crash gaps
   without relaunching uncertain work.
2. Add separately confirmed execution grants with generation and revocation,
   sharing dispatch serialization so renewal/rotation during drain cannot
   pass a stale authority snapshot. Planning grants never gain that scope.
3. Connect fixed update/restart adapters, then catalog installation with exact
   source/license/runtime/destination/staging/headroom/memory validation.
4. Prove the complete receiver authorization, replay, revocation and crash
   chain in fixtures; update receiver/sender UI before advertising execution.

These are sequential implementation steps, not external blockers or authority
to change live peers. Keep execution unavailable until all four are complete.

## Durable ledger foundation (#10127, second slice)

The internal receiver ledger now persists request consumption and bounded operation
states in PostgreSQL. A receiver/sender/request identity has one immutable binding
fingerprint and operation UUID for its lifetime. Changed action, pairing evidence,
grant generation or receiver evidence conflicts with that consumed identity;
renewal and peer removal cannot erase it. Generation floors only increase and
their writes require the current ready execution epoch under the shared database
writer lock, including after lock waits. No grant is created by recording a floor.

Persistence transitions use exact revisions and cannot move uncertain work back
to launch. A recorded claim/receipt is storage evidence, not proof of authorization,
adapter cleanup or completion: the future receiver must verify those facts before
calling the internal persistence API. No route imports that API today.

Database restore rotates a machine-local epoch, captures permanent consumption,
generation floors and owners outside the rewind, and reconciles those facts before
reopening database admission. Capture failure prevents replay. Generic committed
or rollback recovery retains its fence until execution reconciliation finishes;
startup retries the same restore without another replay. Missing or conflicting
facts cannot be replaced with an empty history. Queued/draining storage may sit
behind a journal start whose DB write rolled back, so all nonterminal restored
records remain uncertain. Stronger same-owner claim evidence survives, conflicting
owners refuse reconciliation, and the preserved journal must match and remain
stable. Restore never releases a coordinator claim or interrupts active work.

Filesystem restore preserves the epoch/recovery files and maintenance-owner
subtree, including scoped and mixed-case requests. It does not yet invalidate
execution authority for filesystem-only identity/configuration restores.

The remaining owned sequence is concrete:

1. Coordinate pair rotation, unpairing, disablement, receiver identity changes
   and filesystem-only restore with durable invalidation before their file write.
   Offline disablement must remain possible without acknowledging a generation
   update that was not persisted. Stable slots/floors and deterministic lock order
   must cover every authority writer.
2. Add separately confirmed execution grants and receiver authentication/current
   grant checks. Planning grants keep their existing scope. Bind grant/preflight
   evidence to the non-rewound epoch and recheck expiry after waits.
3. Implement bounded adapter ownership handoff under the same authority lock and
   coordinator claim, with immediate fixed-input resource/source checks. Journal
   start plus DB rollback/disconnect stays uncertain and never retries launch.
4. Implement receiver-owned terminal cleanup verification and epoch-bound one-use
   settlement certificates. Re-read committed terminal evidence before reminting
   after restart/publication failure; restore/cutover fences invalidate old proofs.
5. Complete real disposable-Postgres pairing/revocation/expiry/handoff/certificate
   fixtures, then connect the receiver/sender UI and fixed adapters.

This slice does not close #10127 or enable execution. These are implementation
steps owned by the issue, with no additional live setup or creative approval gate.
