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

- Integrate a **coordinator-owned exclusive claim**, bound to the maintenance
  hold ID/revision, with fresh trusted idle evidence and a resume fence. The
  maintenance admission foundation in PR #10122 does not yet provide that
  atomic claim. `status().state === 'ready'` followed by execution is unsafe;
  ordinary `admit` and a second independent lock are not substitutes. All
  admitted agents, provider work, renders and cleanup must settle naturally;
  no cancel, kill, forced pause or interruption fallback.
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
