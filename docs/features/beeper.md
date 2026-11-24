# Beeper

PortOS mirrors the chats a local [Beeper Desktop](https://www.beeper.com/) install already
bridges — WhatsApp, Discord, Telegram, and whatever else the user has connected — into its own
PostgreSQL store, renders them at **Comms > Beeper** (`/messages/beeper`), and can send one
message at a time through a human-gated outbox. Every request goes to Beeper Desktop's own local
HTTP and WebSocket API, on loopback by default. Nothing about the mirror crosses the federation
layer, and PortOS never talks to Beeper's cloud.

The feature is off by default and ships no credential. It becomes reachable only once the
**Beeper** instance feature is on and a token has been stored.

## What it talks to

Beeper Desktop exposes a local HTTP + WebSocket API. PortOS defaults to
`http://127.0.0.1:23373` (`DEFAULT_BASE_URL` in `server/services/beeper/beeperClient.js`), and
`settings.beeper.baseUrl` makes that editable for an install listening somewhere else. The
loopback literal rather than `localhost` is deliberate: a dual-stack box may resolve `localhost`
to `::1` first.

**`baseUrl` is loopback-only by default.** Every request carries `Authorization: Bearer
<vault-stored token>`, and `baseUrl` is prefixed onto both the REST calls and the realtime
WebSocket URL — a value pointed at an attacker-controlled host would turn one settings write into
a credential exfiltration. `beeperSettingsSchema` (`server/lib/mediaValidation.js`) refuses a
non-loopback `baseUrl` unless the sibling field `allowNonLoopbackBaseUrl` is explicitly set to
`true` (default `false`), and `normalizeBaseUrl` in `server/services/beeper/beeperClient.js` re-applies
the identical check on every read — `settings.json` is not schema-validated when it is loaded, so
a hand-edited file is a second path to the same value the PUT route already refuses; a value that
fails either check falls back to the shipped loopback default rather than reaching a request. The
settings drawer exposes the opt-in as a checkbox beside the Base URL field for the rare install
that genuinely runs Beeper Desktop on another machine.

The client is raw `fetch`, deliberately **not** `@beeper/desktop-api`: the published SDK lags
the live API and exposes no `Account.status`, no `loginID`, and no `/v1/bridges`. `GET /v1/spec`
on the running instance is the reference the client was written against. `server/lib/safeUrlFetch.js`
cannot wrap it — that helper blocks loopback in both postures by design, and this API *is* a
loopback service — so every call goes through `fetchWithTimeout` directly, the same way the
Ollama and LM Studio integrations do.

The endpoints the shipped feature actually calls:

| Beeper endpoint | Used for |
| --- | --- |
| `GET /v1/info` | Liveness probe (it also answers unauthenticated, which is why it is the probe and not a credential check) and the `endpoints.oauth.introspection_endpoint` fallback |
| `GET /v1/accounts`, `GET /v1/bridges` | The account roster, joined into `beeper_accounts` |
| `GET /v1/chats?accountIDs=…` | Conversation ingestion, newest-first |
| `GET /v1/chats/{chatID}/messages` | Message ingestion, and the outbox's confirmation fallback |
| `GET /v1/chats/{chatID}/messages/{messageID}` | The outbox's confirmation fallback |
| `POST /v1/chats/{chatID}/messages` | The one send call, reached only from the outbox |
| `PATCH /v1/chats/{chatID}` | The Archive and Low priority rail controls |
| `POST /v1/chats/{chatID}/read` | Optional read receipts, off by default and consent-gated |
| `GET`/`HEAD /v1/assets/serve` | The attachment mirror — the stream and its size pre-flight |
| `WS /v1/ws` | The realtime transport |
| `/.well-known/oauth-authorization-server` and the endpoints it advertises | Connect and disconnect |

`beeperClient.js` wraps more of the API than the features currently reach — chat and message
search, unread state, reactions, edit and delete, `POST /v1/assets/download`, and the
single-chat GET all have wrappers and tests but no caller in a shipped feature path.

Live verification against a real instance was done on **Beeper Desktop 4.3.89**; the
"[What is not verified live](#what-is-not-verified-live)" section below says what that pass did
and did not cover.

One non-obvious response shape the client encodes, confirmed live: `GET`/`HEAD /v1/assets/serve` answers **502**, not 404, for media the source network has aged
out. A generic "5xx is transient" retry policy would loop forever on it, so an asset-endpoint 502
maps to a terminal `ASSET_UNAVAILABLE`.

Reads may retry once on a replayable connection failure. **Writes never retry** — Beeper has no
idempotency key on send, so a retried POST delivers a second real message to a real person.
`allowRetry` is off by default on every request for exactly that reason, and a thrown
`BeeperApiError` carries a `retryable` flag callers key on rather than re-deriving from the
status code.

**The liveness probe caps at 3s** (`DEFAULT_PROBE_TIMEOUT_MS` in `server/services/beeper/beeperClient.js`
— fork issue #61, decision 7; raised from 1s after that turned out too tight for a briefly-busy
Beeper Desktop). A probe *timeout* specifically — never a fast refusal, which still means
"unreachable" immediately — is ambiguous alone: nothing distinguishes "briefly slow" from
"actually closed" by timing. Paired with a Beeper call that succeeded recently (a real API request
through this client, or the realtime socket receiving a fresh ping) within `RECENT_SUCCESS_WINDOW_MS`
(60s, same file), it reports `probeState: 'slow'` instead — `reachable` **stays `true`**, and the
status card renders the connected card with the measured `probeLatencyMs` rather than jumping to
the unreachable/actionable-fault card. With no recent activity, or for any other failure shape, a
genuinely closed Beeper Desktop still reaches `probeState: 'unreachable'` (and `reachable: false`)
on the very first probe. `reachable: null` (no token configured, the probe never ran) keeps its own
distinct meaning throughout and never collapses into `slow`.

## Setup

1. In **Settings > Features**, make sure the **Comms** group is on and turn on **Beeper**.
   Beeper is off by default and has no auto-detector — a token-presence gate cannot bootstrap
   the very screen that sets the token.
2. Open **Comms > Beeper**, then the settings drawer from the header action
   (deep-linked as `?settings=1`, so ⌘K and voice can open it directly).
3. Connect: either **Connect Beeper** (OAuth) or paste a token from Beeper Desktop's own UI.
   Both are first-class; see below.
4. Turn on **Enable scheduled Beeper sync** and save. Nothing is ingested until this is on.
5. Optionally adjust the sweep interval, the base URL, and the attachment disk budget in the
   same drawer.

The settings the drawer writes are `settings.beeper.{enabled, intervalMinutes, baseUrl,
attachmentBudgetGb, allowNonLoopbackBaseUrl}` — `enabled` false, 5 minutes, the loopback default,
5 GB, and the non-loopback opt-in off. The schema (`beeperSettingsSchema`) is `.strict()` and has
no token field at all, so a credential can never ride the generic settings route.

Storing a credential, flipping the Beeper feature or the Comms group, or saving a change to
**Enable scheduled Beeper sync** itself, arms or disarms both the sweep scheduler and the
realtime transport immediately — `reconcileBeeperIngestion()` in `server/services/beeper/beeperArming.js`
is called from every one of those paths, so no restart is needed and a disconnect stops the relay
rather than leaving it running on a revoked token. **Arming also runs one sweep right away**
(fork issue #79): before this, connecting (or turning a toggle on) registered the interval timer
but the mirror stayed empty until a full interval had elapsed. Changing just the sync interval —
no toggle flip — takes effect the same way, without a restart: `PUT /api/settings` restarts the
scheduler's registration when `beeper.intervalMinutes` changes on its own (see
[The mirror](#the-mirror) below).

**Beeper also bridges iMessage and Signal.** An install that keeps the built-in iMessage or
Signal reader enabled *and* connects the same account through Beeper sees those conversations
twice, once per source. This version builds no cross-source exclusion or dedupe; pick one reader
per network in Settings > Features (the Comms group's per-feature overrides exist for exactly
this) and the mirror stays single-sourced.

## Connecting

**OAuth is run by PortOS itself.** Beeper Desktop's authorization-server metadata advertises a
`registration_endpoint`, `token_endpoint_auth_methods_supported: ["none"]` and
`code_challenge_methods_supported: ["S256"]`, so PortOS registers itself as a *public* client by
dynamic registration (client name `PortOS`, `token_endpoint_auth_method: none`) and runs
authorization-code + PKCE S256 with a `state` parameter. Both scopes (`read write`) are
requested in one authorization — a second consent round trip in the middle of composing a
message is worse than one prompt at setup.

The PKCE verifier never leaves the server. Pending authorizations live in memory keyed by
`state`, expire after ten minutes, and carry the endpoints discovered when the flow started, so
a base-URL change mid-flow cannot steer the callback at a different token endpoint. Every
discovered endpoint is re-validated against the configured base URL: a metadata document naming
a different host or port is refused outright (the loopback spellings count as one host), which
is what keeps a user-editable base URL from becoming a way to POST the authorization code
off-box.

The redirect URI is built from the browser's own `window.location.origin`, which the client
sends with `POST /api/beeper/oauth/start`. That is untrusted input — whatever lands in
`redirect_uri` is where the authorization code is sent — so `server/lib/beeperOAuthOrigin.js`
accepts it only as a bare `http(s)` origin whose host is a loopback spelling, the host the
request arrived on, or a host named by the configured `PORTOS_UI_URL`/`PORTOS_API_URL`. The port
is deliberately not pinned, because the UI and the API are different ports of one install.
Anything else is refused, warned about *without* logging the value, and falls back to the
request-derived origin. This exists because under the Vite dev proxy the request-derived origin
is the API origin, not the UI origin the browser is actually on.

`GET /api/beeper/oauth/callback` is hit by a browser redirect, not by the SPA, so every outcome
renders as a redirect back to `/messages/beeper` with a flag the tab toasts. The authorization
code is exchanged server-side and never reaches the client.

**Pasting a token is a first-class alternative, not a fallback.** Nothing in the OAuth surface
accepts a lifetime, while Beeper's own UI can mint a no-expiry token — and there is no
`refresh_token` grant anywhere in the metadata, so an expired token is re-connected, never
refreshed. A pasted token is verified before it is stored: RFC 7662 introspection when an
introspection endpoint is discoverable (from the metadata document, or failing that from
`/v1/info`'s `endpoints.oauth.introspection_endpoint`, validated through the same same-host
check), otherwise a call that requires the bearer. A token the server refuses is never stored.

**Where the credential lives.** One row, `id = 'default'`, in `beeper_credentials`: AES-256-GCM
ciphertext via `server/lib/vaultCrypto.js`, decrypted only at the moment of use. The token
grants read *and* send across every bridged network and `DELETE /v1/chats/…/messages/…` defaults
to unsending for everyone, so it does not follow the plaintext-settings precedent that root
`AGENTS.md`'s free-service carve-out covers. The token value is never logged, never put into an
error message, and never returned to a route: `GET /api/beeper/status` reports presence, expiry,
provenance and granted scopes only.

The honest limit, stated rather than overclaimed: `ensureVaultKey()` writes the vault key to the
install-root `.env`, on the same disk as the ciphertext. That bounds database dumps, backup
snapshots and accidental echoes. It does not defend against an attacker who already has
filesystem access.

A legacy plaintext `settings.beeper.token` from the original client survives as a **read-only**
fallback so an install that hand-edited one keeps working; nothing writes it.

**Disconnect** (`DELETE /api/beeper/token`) revokes at the authorization server first when the
credential came from OAuth and a revocation endpoint is advertised, then deletes the local copy
either way — a user asking to disconnect must always end up disconnected. It is idempotent, and
it disarms the sweep and the socket.

## The Comms feature group

`beeper` is one of six features in the **Comms** group (`facetime`, `imessage`, `signal`, `x`,
`stacker-news`, `beeper`), declared in `server/lib/instanceFeatureRegistry.js` as a plain `group: 'comms'` on the
feature descriptor. Settings > Features renders the group toggle and each member's own
tri-state override.

Resolution order for a grouped feature (`resolveOne` in `server/services/instanceFeatures.js`):

1. **The feature's own stored override wins**, on or off. Setting it back to "inherit"
   (`null`) drops the stored key entirely rather than writing a third sentinel.
2. **Otherwise the group decides.** Group off hides every member that has not overridden on;
   group on hands the feature back to its own normal resolution.
3. **Then the detector**, when the feature has one.
4. **Then `defaultEnabled`.**

A group's own `enabled` flag defaults to **true** when no group state is stored, so registering
the group never hid a feature an existing install already saw and no settings write was needed
to preserve the previous behaviour. Malformed settings fail toward `false` for both the feature
override and the group flag — untrustworthy settings must not be read as a confident "on".

Beeper itself declares no detector by design, and `defaultEnabled: false`.

The gate is applied to navigation, never to routes: with the feature off, the sidebar row and
the Messages tab pill disappear and `⌘K`/voice stop offering it, but `/messages/beeper` keeps
resolving so a bookmark or a direct link still works.

## The mirror

The mirror ingests chats and messages from Beeper Desktop into PostgreSQL, tracks unread state, attachments and realtime updates, and sweeps stale rows. Internals are in [beeper-mirror.md](./beeper-mirror.md).

## Sending

There is exactly one send path and it is a human one, in two steps and two routes, mirroring the
email drafts surface: `POST /api/beeper/outbox` records the approved text, `POST /api/beeper/outbox/:id/send`
performs the POST to Beeper. No scheduler, no agent, no voice tool and no Chief-of-Staff tool
reaches either — `server/test/guards/runtime/beeperOutboxHumanGate.test.js` asserts that structurally rather
than leaving it to convention. There is no AI drafting and no AI review anywhere on this path.

Send also needs the `write` scope on the stored token. Connect requests both scopes, and Beeper's
consent screen is where the user grants them; a token granted `read` only makes Beeper refuse the
POST with a 403, which the client maps to a terminal `FORBIDDEN`. The outbox row fails in place and
nothing is retried or sent. That is the operator's switch for keeping send off entirely while the
read side keeps working.

Four rules the outbox exists to enforce:

1. **The durable row is written before the POST**, so intent survives a crash between the click
   and the send. The `approved → sending` transition is a conditional UPDATE, so a double-click
   cannot double-post.
2. **A send is never retried automatically.** Beeper has no idempotency key, so a retry delivers
   a second real message. A transport failure leaves exactly one row in `failed`, with its code
   and message, and no second POST. Re-sending means composing a *new* row from a new human
   action; the failed one stays visible.
3. **Confirmation is a resolve, never a re-send.** The send answers only
   `{ chatID, pendingMessageID }`, so the row confirms on the relayed `message.upserted`
   invalidation, with a 30-second fallback to `GET /v1/chats/{chatID}/messages/{messageID}`.
   Neither path sends anything.
4. **A runaway breaker, not a rate quota.** Every send is one human click, so a quota paces
   someone already paced. The breaker catches the failure this design cannot otherwise see — a
   software loop: more than 10 sends in a rolling 60 seconds, or 3 consecutive failures. Only a
   human clears it (`POST /api/beeper/outbox/breaker/clear`); a breaker that clears itself is a
   delay, not a breaker.

**A restart mid-flight** is reconciled at boot, because `sending` and `awaiting-confirmation` are
exit-only through in-memory state (the pending map, its timer, the socket listener) and no route
can move a row out of either. `reconcileOutboxOnBoot()` runs once per server start from
`bootstrap.js`, regardless of whether the Beeper feature is armed — a stranded send is stranded
either way. A row left in `sending` becomes `failed` with `SEND_INTERRUPTED`, because the POST's
outcome is genuinely unknowable and rule 2 has no crash exception: nothing re-POSTs it, and the
user's recovery is the ordinary failed-row Retry, which composes a new row. A row left in
`awaiting-confirmation` has its lookup re-armed from the row's own `chat_id`, `pending_message_id`
and `body` — a resolve on both paths, never a send. Terminal rows are untouched, and a second call
finds nothing left to do.

**First contact** to a conversation is refused with a coded 409 unless `confirmFirstContact` is
explicitly true. It keys on either of two sources of outbound history, scoped to the one
conversation being sent to: a mirrored message with `is_sender` true (sent from any client, not
just this PortOS install), or a prior outbox row that reached Beeper — `sent`,
`awaiting-confirmation` or `sending` — not `sent` alone, so an unconfirmed-but-delivered send does
not re-ask a question that must fire exactly once. Either source alone is enough to count as known;
the confirmation is reserved for a chat neither source has any outbound history for. The composer
renders it inline, naming the network and the recipient — never a `window.confirm`. Cancelling
discards the row through `DELETE /api/beeper/outbox/:id`, which only accepts a row still in
`approved` (nothing has been POSTed for it, so this is a local record removal, never an unsend);
anything further along answers 409.

**What the composer shows.** Outbox rows render inline with the mirrored messages, filtered on the
entry's STATE: a settled `sent` row is dropped outright, because the mirrored message is the
record of it — filtering on "is its message in the page I happen to have loaded" instead left a
long-settled send rendering forever as a spinning bubble with old text, since `GET /outbox`
returns up to 50 entries in every state. Only a send that can still change spins. Everything else
is terminal and says so:

- **Failed** — "Not delivered", with the recorded error and **Retry**, which composes a brand-new
  entry with the same text rather than resending the failed one.
- **Interrupted by a restart** (`SEND_INTERRUPTED`) — "Delivery unconfirmed: PortOS restarted
  mid-send. Check the chat before retrying.", with the same Retry. It does not claim a delivery
  verdict, because there isn't one.
- **Sent, unconfirmed** (`CONFIRMATION_UNRESOLVED`) — the reason the 30-second fallback recorded,
  and no Retry: the message may well have been delivered, and a resend is the one mistake that
  cannot be taken back.
- **Stranded in `approved`** (most often the breaker was tripped when the send was attempted) —
  **Retry**, which re-dispatches that same row because nothing ever touched the wire for it, and
  **Dismiss**, which discards it.

Send is disabled and names the reason while the breaker is tripped — re-read whenever the mirror
signals a change, so a breaker that trips mid-session reaches the composer without a reload; the
breaker's own banner stays in the settings drawer rather than appearing a second time on the chat
surface.

## Purge and disconnect

`DELETE /api/beeper/conversations/:id` purges one conversation's mirror: messages, participants,
attachment rows, and the bytes those rows were holding — with the attachment reference check run
*first*, while the rows it checks against still exist, so a photo forwarded into three other
chats survives. The conversation row and its sync cursor go together in one transaction. It is
local only: Beeper still has the chat, and the next sweep will mirror it again. The client gates
it behind a typed confirmation naming the conversation and the byte count.

Disconnecting deletes the credential (revoking it first where possible) and disarms both the
sweep and the socket. It does not purge the mirror.

## Privacy model

The Beeper mirror holds full message bodies and attachment metadata from every connected network.
It is machine-local, and that is enforced structurally rather than by convention:

- **No `beeper` kind is exposed to peer-sync subscriptions**, no `beeper` wire-schema category is
  declared, no `beeper` dataSync snapshot category exists, and no `beeper_*` table carries the
  `sync_sequence` column that federation is built on.
- **`data/beeper/` never enters the media-library federation walk.** That walk is the other way
  `data/` bytes reach a peer — it walks whole directories rather than record kinds, so none of the
  schema or subscription guards above cover it.
- All of that is pinned by `server/services/sharing/beeperNeverFederates.test.js`, which asserts
  each list is still recognizably populated (so a collapsed list cannot satisfy an empty filter),
  and carries a bypass probe that plants violations to prove the predicates actually fire.
- Attachment bytes are served from an authenticated API route with a row-level check, never a
  static directory mount.
- The realtime relay is invalidation-only and broadcast to the Beeper subscriber set alone, so no
  message content reaches Socket.IO at all — let alone the peer relay.
- The access token is AES-256-GCM ciphertext in Postgres, exposed to any client as presence,
  expiry and provenance and never as a value.

**What leaves the machine:** requests to Beeper Desktop on loopback (or on the configured base
URL), and the one `POST` per message the user explicitly sends. **What never does:** the mirror,
its attachments, the token, and anything on the Socket.IO relay.

## API surface

25 routes under `/api/beeper`, all mounted from `server/routes/beeper.js`.

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/api/beeper/status` | The status card's read model: token presence/expiry/provenance/`tokenScopes` (array of strings, `[]` when unknown — a pasted token, fork issue #78), a cached reachability probe, the account roster, realtime state, outbox breaker, sweep progress (`sweep: { running, startedAt, finishedAt, reason, accountsDone, accountsTotal, chats, messages }`, fork issue #80) |
| `POST` | `/api/beeper/status/check` | Live uncached probe with a coded error per failure mode |
| `POST` | `/api/beeper/sync` | Run one watermark-bounded sweep now; a sweep already in flight reports `skipped: true` |
| `GET` | `/api/beeper/conversations` | Rail list for one scope (network, unread-only, archived, low-priority, snoozed, search), cursor-paginated |
| `GET` | `/api/beeper/networks` | The rail's scope list, derived from the mirror |
| `GET` | `/api/beeper/conversations/:id` | One conversation with its mirrored participant subset; 404 at `severity: 'warning'` for a stale deep link |
| `GET` | `/api/beeper/conversations/:id/messages` | Cursor-paginated messages, newest first |
| `POST` | `/api/beeper/conversations/:id/archive` | Archive control — PATCHes Beeper first, mirrors the answer second |
| `POST` | `/api/beeper/conversations/:id/low-priority` | Low priority control, same shape |
| `POST` | `/api/beeper/conversations/:id/seen` | The local "seen in PortOS" watermark — never a Beeper write |
| `DELETE` | `/api/beeper/conversations/:id` | Purge one conversation's local mirror and its bytes |
| `GET` | `/api/beeper/attachments/summary` | Counts, bytes and the budget picture the consent step and the card need |
| `POST` | `/api/beeper/attachments/backfill` | Bulk-mirror reference-only attachments, stopping at the budget |
| `GET` | `/api/beeper/attachments/:messageId/:idx` | The bytes, from disk, fetched on a miss |
| `POST` | `/api/beeper/attachments/:messageId/:idx/fetch` | "Fetch anyway" for an over-cap row, and the only retry of a refused one |
| `PATCH` | `/api/beeper/attachments/:messageId/:idx` | The per-attachment `keep` lock |
| `POST` | `/api/beeper/oauth/start` | Discover, dynamically register, mint the PKCE authorization URL |
| `GET` | `/api/beeper/oauth/callback` | Browser redirect target; exchanges the code server-side and redirects back to the tab |
| `POST` | `/api/beeper/token` | Store a pasted token after verifying it |
| `DELETE` | `/api/beeper/token` | Disconnect: revoke where possible, then delete locally |
| `GET` | `/api/beeper/outbox` | One conversation's outbox history, newest first |
| `POST` | `/api/beeper/outbox` | Step one — the durable row |
| `POST` | `/api/beeper/outbox/:id/send` | Step two — the send |
| `DELETE` | `/api/beeper/outbox/:id` | Discard an `approved` row; 409 on anything further along |
| `POST` | `/api/beeper/outbox/breaker/clear` | The runaway breaker's only reset |

Socket.IO events:

| Event | Direction | Payload |
| --- | --- | --- |
| `beeper:subscribe` | client → server | Join the Beeper broadcast set (re-emitted on every socket `connect`) |
| `beeper:unsubscribe` | client → server | Leave it |
| `beeper:invalidate` | server → Beeper subscribers | `{ kind, chatID, ids, seq, ts }` — ids and kinds only, never content. `kind: 'beeper-sweep'` (`chatID: null`) is the sweep's own progress frame, fork issue #80 |
| `beeper:realtime` | server → Beeper subscribers | The transport liveness snapshot: `state`, `lastEventAt`, `lastPingAt`, `reconnectAttempts`, `appState`, `appStateActionable`, `authRejected` |

Both surfaces publish as **generated** contract entries. The committed
`apiRouteCatalog.generated.json` is gone: `server/lib/apiRouteGraph.js` now scans the mounted
route graph in memory on the first `/api/api-docs/*` request, and `socketEventInventory.js` does
the same for Socket.IO events, so `/api/beeper/*` and `beeper:*` are discovered from the mounted
router and the emit sites rather than from a checked-in file — nothing to regenerate when a
Beeper route is added. `/api/beeper` still appears in `docs/API.md`'s route-domain index, and
neither `server/lib/apiOperationContracts.js` nor
`server/lib/socketEventContracts.js` models any Beeper operation or event — so the catalog and
spec endpoints listed in [API_TOOL_CONTRACT.md](../API_TOOL_CONTRACT.md) report every one of them
with `contractStatus: "generated"` (path parameters and a default response, no richer modeled
contract).

## What is not verified live

Live probing of a real Beeper Desktop (4.3.89 on the most recent pass) established the
authorization-server metadata document, `/v1/info`'s advertised introspection endpoint, the
`POST /v1/assets/download` 200-with-`{error}` shape, the 502-on-missing-asset behaviour of
`GET`/`HEAD /v1/assets/serve`, `serve` sending no `Content-Type`, the `/v1/accounts` `bridge`
object shape, and a 105-second `app.state`/ping probe of `/v1/ws`.

A later end-to-end pass against the same instance, on the build that includes the upstream
merge, exercised the OAuth connect flow (dynamic registration, consent, the redirect landing on
the UI origin, disconnect revoking at the authorization server), realtime domain frames through
the shipped transport after an in-session connect, sends through the outbox on several networks
each resolved by its confirmation frame, the list header's "Syncing… N of M accounts" strip moving
during a multi-account sweep, the Low priority rail control's `PATCH`, attachments, and a purge. The
Tribe linking surface (title chip, search-first picker, create-and-link, change, unlink, and the
Tribe page's linked-handles block) was exercised by hand on a real install.

The following have **not** been observed against a real instance, and rest on unit, route and
component tests plus static analysis:

- **The `HEAD /v1/assets/serve` pre-flight and byte fidelity.** Whether the instance reports a
  usable `Content-Length` on `HEAD`, and whether a mirrored file is byte-identical to the source,
  have not been checked. (The 502 behaviour on both methods has.)
- **The in-flight image placeholder in a real browser.** jsdom cannot measure layout, so the
  tests pin the declared `aspect-ratio` and width, not the reserved box. Someone should watch a
  thread with an uncached image load in Chrome and confirm nothing reflows.
- **The conversation-not-found 404's `severity: 'warning'` path** was verified by the server
  suite and by static analysis of the socket and hook chain, not observed running.
- **A durable Tribe identity claim surviving a purge followed by a resweep** rests on the db
  tests and on one backfill run against a single real install; nobody has purged and resweeped a
  linked install by hand since.

## Files

- `server/services/beeper/beeperClient.js` — the HTTP client, pagination, error mapping, asset streaming
- `server/services/beeper/beeperOAuth.js`, `beeperCredentials.js` — connect, disconnect, the vault
- `server/services/beeper/beeperSync.js`, `beeperScheduler.js`, `beeperArming.js` — the sweep and its gates
- `server/services/beeper/beeperSweepProgress.js` — the sweep-progress leaf module `beeperStatus.js` reads
- `server/services/beeper/beeperSocket.js`, `beeperSocketEvents.js` — the realtime transport and its bus
- `server/services/beeper/beeperConversations.js`, `beeperAttachments.js`, `beeperAttachmentGc.js` — the read model, the byte mirror, the housekeeping sweep
- `server/services/beeper/beeperOutbox.js`, `beeperStatus.js`, `beeperTribe.js` — sending, the status card, identity linking
- `server/lib/db/schema/beeper.js` — the eight `beeper_*` tables
- `server/routes/beeper.js` — every route above
- `client/src/components/messages/BeeperTab.jsx` and `components/messages/beeper/` — the chat surface, thread, composer, attachments, settings drawer
- `server/services/sharing/beeperNeverFederates.test.js` — the federation guard
