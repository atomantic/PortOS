# Companion-App API Contract

The stable HTTP contract a native companion client (working name **PortDeck**;
repo `atomantic/PortDeck`) consumes to discover, authenticate to, and drive one
or more PortOS instances across a Tailscale tailnet.

> **Scope.** This documents the **PortOS-side** contract only. The iOS app itself
> (Swift/SwiftUI, Keychain, iCloud store, UI) lives in its own repository per the
> Scope Boundary rule in `CLAUDE.md` — its code, plan, and docs never land in this
> repo. Everything below already exists in PortOS today unless explicitly marked.

## Deployment shape the app targets

A single user commonly runs **several PortOS installs federated as sync peers**
over Tailscale. Each install:

- Serves its API on **`:5555`** at the tailnet host (MagicDNS name or Tailscale IP).
- Speaks **HTTP or HTTPS** depending on whether a TLS cert is provisioned
  (`npm run setup:cert`). When HTTPS is on, `:5555` is TLS-only and a loopback HTTP
  mirror runs on `127.0.0.1:5553` (not reachable over the tailnet). See
  [PORTS.md](./PORTS.md).
- Has an **optional single password** gate. When off, the tailnet-private trust
  model means the app needs no credential; when on, every `/api/*` request needs
  credentials (see [Authentication](#authentication)).

The app therefore treats each instance as `{ scheme, host, port: 5555, password? }`
and must handle both the auth-on/auth-off and HTTP/HTTPS cases per instance.

## 1. Discovery & identity (pre-auth)

`GET /api/system/health` — **public**, bypasses the auth gate even when the
password is on (`PUBLIC_API_PATHS` in `server/lib/authGate.js`), and is the same
endpoint Tailscale reachability checks hit. Use it to confirm a tailnet host is a
PortOS instance and to label it on a connection screen **before** the app holds
any credential.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-07-16T00:00:00.000Z",
  "uptime": 12345.6,
  "version": "1.2.3",
  "hostname": "host-XXXX",
  "instanceId": "3f2a…-uuid",
  "name": "Example Instance",
  "authRequired": true,
  "scheme": "https"
}
```

| Field | Meaning |
|-------|---------|
| `instanceId` | Stable per-install UUID (`crypto.randomUUID()`, persisted in `data/instances.json`). The identity key the app stores per connection; survives hostname changes. `null` before the self-identity is first created. |
| `name` | User-set display name for the instance (`self.name`), falling back to `hostname` when unset. This is what to show in the instance list. |
| `hostname` | OS hostname of the machine. |
| `authRequired` | `true` when the password gate is on — the app must obtain a password and send it on subsequent requests. `false` when off — no credential needed. Lets the app decide whether to prompt **without** a second round-trip to `/api/auth/status`. Mirrors the server's `isAuthEnabled()`; the app should still handle a `401` on a gated request as the authoritative signal to (re)prompt. |
| `scheme` | `"http"` or `"https"` — the scheme `:5555` serves, decided once at boot. Use it to build request URLs and label the connection's security. |
| `version` | PortOS release the instance is running — useful for compatibility gating. |

These fields are additive and non-sensitive: exposing `name`/`hostname`/
`instanceId` to tailnet peers is within the trust model. No mutation or config
route is exposed pre-auth.

## 2. Authentication

PortOS auth is a single optional password (`server/services/auth.js`,
`server/lib/authGate.js`). The app authenticates as a **full session via HTTP
Basic**, reusing the exact path peer-to-peer federation uses — nothing new to
build server-side.

- **When `authRequired` is `false`:** send no credential. All `/api/*` routes are
  open on the tailnet.
- **When `authRequired` is `true`:** send
  `Authorization: Basic base64(":" + password)` on every `/api/*` request. PortOS
  is single-user, so the username half is ignored — only the password is verified.
  Store the password **per instance in the iOS Keychain**.

**CSRF note.** When auth is on, PortOS 403s cross-origin requests that carry an
`Origin` header (the browser-session CSRF guard). A native `URLSession` sends **no**
`Origin` header, so it passes the guard cleanly — no special handling needed. Do
not set an `Origin` header manually.

A dedicated per-device API-key surface (a companion group in `apiRegistry.js` /
long-lived device token) is a **possible future enhancement**, not built here —
the single-password Basic posture works today and reuses the whole gate.

## 3. Instance management

Full CRUD + peer operations at `/api/instances/*` (`server/routes/instances.js`,
`server/services/instances.js`). The foundation the app's instance-management UI
builds on:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/instances` | Self + all configured peers. |
| `GET` | `/api/instances/self` | This instance's identity (`instanceId`, `name`). |
| `PUT` | `/api/instances/self` | Rename this instance. |
| `GET` | `/api/instances/tailnet-suffix` | The tailnet's MagicDNS suffix. |
| `GET` | `/api/instances/sync-status` | Federation sync status. |
| `POST` | `/api/instances/peers` | Add a peer. |
| `PUT` / `DELETE` | `/api/instances/peers/:id` | Update / remove a peer. |
| `POST` | `/api/instances/peers/:id/connect` | Establish a peer connection. |
| `POST` | `/api/instances/peers/:id/reciprocate` | Reciprocate a peer connection. |
| `POST` | `/api/instances/peers/:id/probe` | Probe a peer's reachability. |
| `POST` | `/api/instances/peers/:id/sync` | Trigger a sync with a peer. |
| `GET` | `/api/instances/peers/:id/query?path=/api/…` | Proxy a request through a peer. |

## 4. Quick actions, brain capture & daily log — the palette bridge

Non-DOM voice/palette actions are dispatchable over plain HTTP via the command
palette bridge (`server/routes/palette.js`) — the app drives these directly and
navigates its own UI from the manifest's nav list.

- `GET /api/palette/manifest` — returns the navigable-page list (`nav`) plus the
  whitelisted action schemas (`actions`). DOM-driving `ui_*` tools are
  intentionally excluded, so the app renders its own UI and uses `nav` for routing.
- `POST /api/palette/action/:id` — dispatch a whitelisted action. Body:
  `{ "args": { … } }` (args object optional, defaults to `{}`). Returns
  `{ ok, result }`. Unknown ids 404.

Palette action ids the app is expected to use (`PALETTE_ACTIONS` in
`server/routes/palette.js` — always read the live manifest for the authoritative
list and each action's parameter schema):

| id | Purpose |
|----|---------|
| `brain_capture` | Capture a note to the Brain. |
| `brain_search` / `brain_list_recent` | Search / list recent Brain entries. |
| `daily_log_append` | Append a line to today's daily log. |
| `daily_log_read` | Read today's daily log. |
| `goal_list` / `goal_update_progress` / `goal_log_note` | List goals, update progress, log a note. |
| `meatspace_log_drink` / `_nicotine` / `_weight` / `_workout` | Log health events. |
| `meatspace_summary_today` | Today's health summary. |

### Daily-log append (direct route)

Dictation is transcribed **on device** (or server-side over Socket.IO); the
resulting text is POSTed as plain text. There is **no** server-side audio/STT
upload endpoint.

- `POST /api/brain/daily-log/:date/append` — body `{ "text": "…", "source": "…" }`.
  `:date` accepts `today` (resolved server-side) or `YYYY-MM-DD`. Empty/whitespace
  `text` 400s. `source` records the **input modality** and is a controlled
  vocabulary — one of `text`, `voice`, or `edit` (any other value is silently
  normalized to `text` by `brainJournal.normalizeSource`). A dictated capture sends
  `"voice"`; a typed one sends `"text"`. It is **not** a free-form app-identity tag.
- `GET /api/brain/daily-log/:date` — read a day's log.

The palette `daily_log_append` / `daily_log_read` actions cover the same feature but
are **not** interchangeable with these routes — pick per your need:

- `daily_log_append` (palette) always tags the entry `source: "voice"` and returns a
  voice-tool result shape (`{ ok, date, summary, … }`). Use it for dictated captures.
- The direct `POST …/append` route honors the `source` you send and returns
  `{ date, entry }`. Use it for a **typed** entry (`source: "text"`) or when you need
  the structured `entry` back.

## 5. MeatSpace POST training & testing

`/api/meatspace/post/*` (`server/routes/meatspacePostRoutes.js`). These are the
read/write endpoints for POST config, sessions, and progress on a single instance.

> **Note — POST progress does not cross-peer federate today.** The `meatspace`
> peer-sync category (`MEATSPACE_FILES` in `server/services/dataSync.js`) covers the
> daily-log and health-record files but **not** the POST files
> (`post-sessions.json`, `post-config.json`, …), so POST progress written to one
> instance stays local to it. Cross-instance POST reconciliation is a deferred
> follow-up (see below) — either add the POST files to the sync category or ship the
> iCloud import endpoint. A companion app that shows POST progress across instances
> must read each instance's `/api/meatspace/post/*` directly until then.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` / `PUT` | `/api/meatspace/post/config` | Read / update POST config. |
| `GET` | `/api/meatspace/post/sessions` | List training sessions. |
| `POST` | `/api/meatspace/post/sessions` | Record a session. |
| `GET` | `/api/meatspace/post/progress` | Current progress. |
| `GET` | `/api/meatspace/post/stats` | Aggregate stats. |
| `GET` | `/api/meatspace/post/recommendations` | Recommended next drills. |

The app can *prompt* the user to run POST training from the phone and POST the
resulting session, or sync progress via the iCloud pattern below.

## 6. iCloud-JSON sync precedent (POST-progress reconciliation)

The working reference for "iOS app writes an iCloud JSON file, PortOS ingests it"
is MortalLoom (`server/routes/mortalloom.js`, `server/services/mortalLoomStore.js`):

- `GET /api/mortalloom/status` — store status.
- `POST /api/mortalloom/import` — non-destructive **by-id merge** of the shared
  iCloud JSON into `data/`.

A POST-progress iCloud reconciliation endpoint mirroring this
(`POST /api/…/import`, non-destructive by-id merge into `data/meatspace/post/*`) is
**out of scope for this foundation** and will be filed as its own follow-up. Until
it lands there is no cross-instance POST reconciliation — a companion app reads and
writes each instance's `/api/meatspace/post/*` routes directly (see the note in
§5).

## Deferred follow-ups (filed separately)

- POST-progress iCloud reconciliation import endpoint (mirrors `mortalloom.js`).
- Server-side audio/STT upload endpoint — only if on-device transcription is
  abandoned.
- Push-notification / reminder plumbing to prompt POST training from the phone.
- A dedicated companion `apiRegistry.js` public group + per-device API token, if
  the single-password posture proves insufficient.

## See also

- [API.md](./API.md) — full REST/WebSocket reference and route-domain index.
- [PORTS.md](./PORTS.md) — port allocation and HTTP/HTTPS scheme.
- Machine-readable spec: `GET /api/api-docs/openapi.json` (public-API surface only).
