# Peer administration

Peer administration is receiver-authorized, private federation between paired
instances. Installation, pairing, discovery, display names, and planning grants
never authorize execution. Development and fixture tests do not create live
grants, downloads, updates, or restarts.

## Setup and supported actions

On the receiving host, open Instances → the peer → Peer administration. Compare
both instance UUIDs, then review a separate, action-specific execution grant.
`execution-v1` requires explicit confirmation; existing `planning-v1` grants
remain planning-only. The UI grants one hour; the API permits one minute through
24 hours. The audit identity is the server-derived operator session (including
delegated agent sessions), or a genuine local operator on a password-free host.
Setup and local catalog review retain `requireHostControl`.

The fixed action vocabulary accepts no arbitrary commands, credentials, paths,
URLs, force flags, scripts, import recipes, or license-acceptance flags:

- `portos.update`: the receiver's clean `main` checkout, pinned to the exact
  preflight origin commit. Forks must be synchronized locally first. The adapter
  preserves fork-aware preflight and never forces, resets, or rebases divergent
  work. Pinned updates use fast-forward only.
- `portos.restart`: only the receiver's verified PortOS server and CoS processes.
  Script identities are verified; no unrelated applications are restarted.
- `catalog.install`: only supported, receiver-reviewed single-file LM Studio
  GGUF catalog artifacts. Configure `LM_STUDIO_MODELS_DIR` locally to the actual
  LM Studio model folder; the adapter refuses a guessed default. A local review binds the catalog key, immutable source
  revision, filename, SHA-256, exact size, license, installed runtime,
  destination, and runtime memory requirement. Source repositories and actual
  destinations are derived by the receiver. Unknown, gated, unreviewed, changed,
  unsupported, or insufficient-resource entries deny. Ollama, MLX, and sharded
  artifacts are not supported by this execution adapter.

Catalog review is configuration, not a download, model launch, acceptance of new
terms, or permission to execute. A paired sender still needs the separate
catalog execution grant. Installation verifies the streamed byte count and hash
before publication and never replaces an existing destination file.

On the sending host, prepare the desired action, inspect its exact signed
preflight, then request execution. The sender stores the request identity and signed preview before
sending and refuses dispatch if that recovery record cannot be read back.
An uncertain response retains the request and offers **Check status**; it never
starts another attempt automatically. The receiving host owns the durable ledger;
browser storage retains the evidence needed to recover its receipt. A proven local
pre-send rejection permits a fresh preview. A timeout or unsigned remote refusal
never does.

## Authority and drain

Execution grants are machine-local settings, bound to both instance UUIDs,
current pair credentials, action, grant ID/generation, expiry and the non-rewound
execution epoch. Grant changes use compare-and-swap on the previous grant ID and
advance the PostgreSQL generation floor before publishing policy. A failed policy
write therefore cannot leave old authority active.

Execution shares the instance identity writer lock through the launch handoff.
Credential, peer enablement/membership, or receiver identity changes rotate the
machine execution epoch before publication. This invalidates all execution grants
on that receiver; review new grants afterward. Ordinary telemetry/name changes
preserve grants. Restoring instance identity files also rotates the epoch under
that lock. Grants and execution receipts are never restored from snapshots.

The receiver consumes a request durably before side effects. Its own maintenance
hold drains admitted agents, provider work, renders, saves and cleanup naturally.
It never kills or cancels active work. It claims the exact hold ID/revision using
a fresh coordinator-owned idle observation, then rechecks identity, grants,
version, source and resource evidence. Resume and ordinary admission share this
same journal transaction; a separate lock or a ready-status read cannot launch.

A one-use in-process capability binds the exact in-flight claim to a fixed action
and evidence digest. Copies, recovered claims, stale revisions and repeated use
cannot launch. Revocation during drain prevents dispatch. After launch, revocation
does not interrupt work already running; the receiver reconciles that operation.

## Protocol and recovery

Planning endpoints retain their original behavior under
`/api/federation/admin/v1/{preflight,plans,receipt,execute}`. Planning `execute`
always refuses; upgrading never turns a temporary plan into queued work.

Separate execution POST endpoints are
`/api/federation/admin/v1/execution/{preflight,dispatch,status}`. Every endpoint
requires the current scoped paired credential, including on password-free hosts.
The sender never forwards Basic auth, instance passwords, sessions or agent tokens.
Exact endpoint admission does not grant general host-control access.

Execution preflights expire within 60 seconds and bind the request, both UUIDs,
grant generation, receiver version, epoch, fixed intent and evidence digest.
Execution signatures use canonical JSON and a separate HMAC purpose; planning
wire signatures remain compatible. Dispatch returns acceptance, not completion.
Changed input under a consumed request ID is refused permanently, including after
restart, grant renewal or database restore. Identical retries return the existing
operation; there is no second launch.

States are `queued`, `draining`, `in-flight`, `awaiting-reconnect`, `succeeded`,
`failed` and `uncertain`. Active ledger rows are capped at 32; preflights at 128.
Timeouts, disconnected callers, dead PIDs, and general host health never prove
completion. Unknown side effects retain exclusive ownership. Boot never replays a
launch; explicit status reads can reconcile exact completion evidence arriving
after boot. Terminal database persistence, journal settlement and hold release
are independently recoverable, including crashes between those boundaries.

Status requests can include the original signed preview. When the receiver has
never consumed that request, it verifies the signature and both instance identities,
then atomically records a permanent failed receipt under the same database lock
as dispatch. That receipt proves no launch occurred and prevents any delayed
dispatch or reused preflight from starting it later. Already accepted requests
retain their original state. This recovery works after receiver restart, grant
revocation and epoch rotation while the original pair credential remains valid;
it never restores authority from the preview. A request without verifiable
original evidence remains unresolved instead of treating a bare 404 as proof.

Updates and restarts write per-operation launch evidence before starting their
detached adapter. Reconciliation requires its exact successful exit receipt and
matching target evidence: restarted fixed process identities, or the expected
boot/current commit with verified build, dependencies, submodules and migrations.
Catalog installation requires its verified artifact and completed publication.
Missing or conflicting evidence remains uncertain. No generic rollback or force
Ready button exists. Proven completion releases only the operation's own hold and
re-evaluates the already-saved scheduling policies; it never enables a policy.

The durable receiver ledger and restore reconciliation are documented in
[STORAGE](../STORAGE.md#receiver-execution-ledger-foundation-10127). Fixtures cover
authorization refusal, planning compatibility, revocation/rotation during drain,
replay, resume fencing, crash gaps, delayed completion and negative resource/hash
checks without operating any live peer.
