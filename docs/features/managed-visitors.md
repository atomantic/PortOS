# Local managed-app visitor broker

The version-1 broker provides an explicit, app-scoped route to a separately configured nonhumanoid Eidoverse host. It never reuses peer/Mind travel, humanoid guest tickets, the owner identity or ordinary PortOS session credentials as app authority. It makes no boot traffic and starts no host. Without a configured host credential and exact negotiated capabilities it returns unavailable.

## Owner setup and credential lifecycle

Use the ordinary PortOS owner API:

- `GET /api/managed-visitor-admin` lists credential metadata and allowed scopes, never hashes or plaintext credentials.
- `POST /api/managed-visitor-admin/:appId/credential` provisions or rotates a credential for an existing, unarchived managed-app record. Body: `{individualIds:["individual-a"],worldIds:["quiet-garden"],ttlMs:86400000}`. IDs start with a letter or digit and contain 1–128 letters, digits, dots, underscores, colons or hyphens. Allow 1–64 individual IDs and 1–32 worlds. Credential lifetime is 1 minute to 7 days. The response contains `credential` **once**, plus scope and expiry metadata; do not log or publish it. Rotation revokes existing sessions.
- `DELETE /api/managed-visitor-admin/:appId/credential` revokes its credential and current sessions.

When an instance password is set, management requires a verified owner session; a peer Basic credential is insufficient. When the password is unset, management retains PortOS's existing private-install owner API posture: no authenticated human identity can be inferred. Cross-origin requests and app bearer credentials are rejected by management in either posture. A local process with unrestricted access to the passwordless owner API is not sandboxed by this feature.

`data/managed-visitor-credentials.json` contains only SHA-256 credential digests, app IDs, exact scope allowlists and timestamps. It is bounded to 64 credentials and 64 KiB, machine-local and never federated. Admission/session authority is memory-only and is forgotten on restart. A restart does not resume any visit.

The host administrator separately configures matching **64 lowercase hexadecimal characters** in `PORTOS_EIDOVERSE_VISITOR_TOKEN` for PortOS and Eidoverse. This host credential is distinct from every app credential. The Eidoverse host also requires its explicit world allowlist. No command in this document configures, starts or restarts a live host; setup is a deliberate operator action after both source implementations are reviewed.

## App-facing protocol

Every `/api/managed-visitors/v1/*` request requires `Authorization: Bearer <credential>` and a direct loopback socket. The broker accepts neither forwarded-IP claims nor ordinary owner sessions as substitutes. The same credential verification runs whether the instance password is set or unset. A credential never grants access to other password-protected PortOS APIs. Observer/browser UI should not receive these backend credentials.

`GET /capabilities` returns `{version:1,available,appId,worldIds,individualIds,contract,reason}`. Availability requires the host's explicit `managedVisitors` contract; old `guestEntry` support alone is insufficient.

`POST /admissions` accepts exactly:

```json
{"individualId":"individual-a","individualSessionId":"runtime-a","worldId":"quiet-garden","body":"fly-v1","ttlMs":30000}
```

TTL is 1–300 seconds and cannot outlive the app credential. Each app/individual has at most one live or pending admission, across all worlds and runtime sessions. The global admission bound is 64. A successful response contains `version`, the authenticated `appId`, the three requested scope IDs, opaque broker `sessionId`, `epoch`, `expiresAt`, `status:"paused"` and `pose:{x,z,yaw}`. Admission never starts movement. Every subsequent request must carry that exact scope and epoch. Restore/replacement must leave and explicitly admit the new individual runtime session.

`POST /sessions/:sessionId/observations` body is exactly `{individualId,individualSessionId,worldId,epoch}`. The response adds `version`, `appId`, the same broker `sessionId`, `frameId`, `capturedAtMs`, `camera:"controller"`, `width:8`, `height:4`, `rgb` (96 integer bytes), `pose`, and `sensorySource:"engineered-gentle-patch-spatial-proxy-v1"`. This host source is an engineered spatial proxy from its declared gentle patch, **not rendered retinal imagery or validated fly vision**. Responses must advance frame IDs and be at most 250 ms old. Unknown/private fields are rejected rather than forwarded.

`POST /sessions/:sessionId/actions` takes the same scope plus `sequence` (starting at zero, increasing by exactly one) and one action:

```json
{"type":"start"}
{"type":"pause"}
{"type":"rest"}
{"type":"leave"}
{"type":"move","forward":0.05,"yaw":0.1,"intervalMs":5}
```

Movement is bounded to forward speed 0–0.12 and yaw speed −0.8–0.8 per second over exactly 5 ms. Pose is bounded to x/z ±2 and yaw ±π. Host actions return the same scope plus `sequence`, `status`, `pose` and the unchanged expiry. These are engineered controls; arbitrary verbs, scripts, messages, neural state, weights, private history and tool calls are never accepted.

One operation per session can be pending. Malformed, mismatched or uncertain host responses revoke local authority and attempt scoped host cleanup; no uncertain action is retried. Credential rotation during a pending admission/action cannot publish new authority for the old credential. A backward broker clock revokes active authority. Expired, revoked, wrong-app, wrong-world, wrong-individual/session/epoch and replayed requests are refused.

## Host-facing contract

Requests go only to fixed loopback port 8940 under `/api/managed-visitors/v1`, with the separate host bearer, a three-second deadline, redirects disabled and response buffering capped at 16 KiB. `/version` must negotiate:

```json
{"capabilities":{"managedVisitors":{"version":1,"bodies":["fly-v1"],"controllerRaster":{"width":8,"height":4,"channels":3},"actions":["start","pause","rest","move","leave"],"expiryEnforced":true,"admissionDeadline":true}}}
```

Host admissions add `version:1` and the authenticated `appId` to the app request. Later host operations add `appId` to the scoped body and use the private host session ID, which PortOS never exposes as app authority. Host admission/action responses include `expiresAt`; the broker checks it and clamps the outward deadline to its own earlier limit. Both layers independently enforce scope and expiry.

A dedicated unsequenced `POST /sessions/:hostId/leave` takes `{appId,individualId,individualSessionId,worldId,epoch}` for idempotent revocation. It must invalidate a pending action even when its sequence is uncertain. This is how credential revocation avoids racing the normal action sequence. If the host cannot be reached, broker authority is still revoked immediately and independently enforced host expiry bounds the remaining ephemeral presence.

This foundation does not implement connectome execution, retained learning, travel consent inference, arbitrary world authority or client-side embodiment. Fly Garden remains paused at home unless its own explicit visitor adapter is subsequently enabled. Source changes do not enable a production visitor.

## Reconcile interrupted admission and return

`POST /sessions/:sessionId/leave` accepts the exact ordinary scope without a sequence. It revokes pending action authority immediately; a late action cannot become current again. Return is acknowledged only after matching host cleanup or the trusted admission deadline. An unconfirmed cleanup retains a revoked receipt so a retry cannot mistake the missing active session for an acknowledged return.

When an admission times out before returning a session ID, use `POST /admissions/cancel` with exactly `{individualId,individualSessionId,worldId}` and the app credential. It cancels matching pending attempts and removes matching published visits, without touching another recipient or runtime session. The response contains `version`, `appId`, those scope IDs, `confirmed`, `pending` and nullable `expiresAt`. Keep local embodiment ownership paused while `confirmed:false`; retry cancellation until confirmed. A pending acknowledgment is cleaned when it arrives and cannot publish authority after cancellation.

Host negotiation additionally requires `admissionDeadline:true`. Every host admission carries `X-Managed-Visitor-Deadline`, an absolute same-machine wall-clock upper bound chosen before the host call. The host must validate it after consuming the body and clamp its lease expiry to that bound. If the host call itself times out without a lease ID, PortOS keeps a revoked unresolved receipt until this trustworthy deadline. Invalid host expiry values cannot extend that bound. A stale or older host lacking this capability is unavailable; no TTL is guessed from receipt time.

After a broker restart, host leases may remain while their private receipt mappings have been lost. Unknown cleanup therefore remains unconfirmed until broker boot time plus the maximum 300,000 ms host lease. Original-scope cancellation exposes this bound; unknown session leave refuses premature confirmation. Exact current-process cleanup receipts remain immediately idempotent, and a successfully acknowledged current-process admission establishes its original scope. These bounded proof caches hold at most 256 entries; eviction can conservatively delay confirmation. Backward clock movement fails closed. No restart cleanup grants access outside the credential's individual/world allowlists.
