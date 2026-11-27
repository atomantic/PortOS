# Local managed-app visitor broker

The broker connects an app to a separately configured Eidoverse host. App visitors use a distinct credential from peer travel and owner sessions. The host and its capabilities must be available before admitting a visitor.

## Owner setup and credential lifecycle

Use the ordinary PortOS owner API:

- `GET /api/managed-visitor-admin` lists credential metadata and allowed scopes, never hashes or plaintext credentials.
- `POST /api/managed-visitor-admin/:appId/credential` provisions or rotates a credential for an existing, unarchived managed-app record. Body: `{individualIds:["individual-a"],worldIds:["quiet-garden"],ttlMs:86400000}`. IDs start with a letter or digit and contain 1–128 letters, digits, dots, underscores, colons or hyphens. Allow 1–64 individual IDs and 1–32 worlds. Credential lifetime is 1 minute to 7 days. The response contains `credential` **once**, plus scope and expiry metadata; do not log or publish it. Rotation revokes existing sessions.
- `DELETE /api/managed-visitor-admin/:appId/credential` revokes its credential and current sessions.

With a password configured, administration requires a verified owner session. Cross-origin requests and app credentials are refused. Credential digests and their scope stay local. Admission authority expires and is forgotten when PortOS restarts.

Configure the same 64 lowercase hex characters in `PORTOS_EIDOVERSE_VISITOR_TOKEN` on both PortOS and the Eidoverse host. The host also needs its world allowlist. Keep this host token separate from app credentials.

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

## Reconcile interrupted admission and return

`POST /sessions/:sessionId/leave` accepts the exact ordinary scope without a sequence. It revokes pending action authority immediately; a late action cannot become current again. Return is acknowledged only after matching host cleanup or the trusted admission deadline. An unconfirmed cleanup retains a revoked receipt so a retry cannot mistake the missing active session for an acknowledged return.

When an admission times out before returning a session ID, use `POST /admissions/cancel` with exactly `{individualId,individualSessionId,worldId}` and the app credential. It cancels matching pending attempts and removes matching published visits, without touching another recipient or runtime session. The response contains `version`, `appId`, those scope IDs, `confirmed`, `pending` and nullable `expiresAt`. Keep local embodiment ownership paused while `confirmed:false`; retry cancellation until confirmed. A pending acknowledgment is cleaned when it arrives and cannot publish authority after cancellation.

Host negotiation requires `admissionDeadline:true`. Each admission carries `X-Managed-Visitor-Deadline`. The host validates it and clamps lease expiry to that same-machine deadline. After a restart, unknown cleanup can remain pending until broker boot plus the maximum 300-second host lease. Keep the app paused until cancellation is confirmed.
