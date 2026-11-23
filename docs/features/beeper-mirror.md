# Beeper mirror internals

Sync, storage, unread, attachment, realtime and sweep internals of the Beeper mirror. Part of the [Beeper guide](./beeper.md).

## The mirror

Ingestion is an HTTP sweep, not a socket feed. Beeper's WebSocket is at-most-once with no replay
on reconnect and drops events during hydration while the connection still looks healthy, so a
poll that ran only when the socket was down would be asleep during two of the three loss paths.
The socket makes ingestion *prompt*; the sweep makes it *complete*, and it runs unconditionally
on its own timer.

`server/services/beeper/beeperScheduler.js` is the fifth instance of the shared `createSyncScheduler`,
alongside iMessage, Signal, Spotify and YouTube. It is gated twice, and the two flags are
deliberately different things:

- `isBeeperIngestionArmed()` — the **instance feature** plus a stored token. Checked silently: a
  fresh install with the feature off narrates nothing it does not have.
- `settings.beeper.enabled` — the **user's ingestion opt-in**, re-read on every tick, so
  turning it off mid-session stops runs without a restart.

The registered event's own first tick lands one interval after registration, never at boot — a
process restart never fires a network sweep by itself, and neither does a plain re-registration
(the interval-change path below re-registers without touching this). Fork issue #79's fix sits
ONE layer up: `beeperArming.js`'s `reconcileBeeperIngestion()` fires `runBeeperSweep({ reason:
'arm' })` directly, fire-and-forget, whenever a reconcile is the one that newly registers the
scheduler — connecting, or turning the Beeper feature or the sync toggle on — never on the boot
call in `bootstrap.js`, which never reaches that reconcile at all. So a fresh arm gets one sweep
right away and the registered interval fires on its own schedule after that, unaffected.

The interval itself is read fresh at every *registration*, but a **running** registration does not
notice a settings change mid-flight — changing `intervalMinutes` alone used to take effect only at
the next process restart. `restartBeeperScheduler()` (`server/services/beeper/beeperScheduler.js`) is the
fix: cancel the current registration and register a fresh one, which reads
`getBeeperSyncConfig()` again. `PUT /api/settings` calls it when a save changes
`beeper.intervalMinutes` without also flipping `enabled`. An `enabled` flip alone does not always
get a fresh registration: a true→false save deliberately leaves the scheduler registered (it just
gates per tick), so a false→true flip right after finds it already registered and
`reconcileBeeperIngestion()`'s own guard declines to re-register it. When that combination lands —
a flip on an already-registered scheduler, with the interval also changed in the same save — `PUT
/api/settings` restarts the scheduler explicitly too, right after reconciling, so the stale
interval does not survive (fork issue #94). Deliberately no immediate sweep on the restart path:
only arming kicks one, and firing a sweep on every interval edit would surprise a user who is just
tuning a number.

Per account, one sweep:

1. refreshes `beeper_accounts` from the live roster;
2. pages `GET /v1/chats?accountIDs=…` newest-first, sweeping every chat on the page that is newer
   than the stored `beeper_sync_cursors.last_activity` watermark, and **stops at the first page
   that asks for no sweep at all**. One caught-up chat does not end the walk: the list is ordered
   by last activity, not by eligibility, and a chat whose forward walk was truncated keeps its old
   watermark on purpose, so it stays eligible while sorting below chats that are already caught up;
3. for each changed chat: upserts the conversation, upserts participants, pages new messages
   forward from the stored opaque cursor, logs daily Tribe touchpoints, then commits message
   rows, attachment references and the cursor row in **one transaction**.

That transaction boundary is the point of the module: an interrupted sweep leaves the cursor
exactly where it was and the next sweep refetches the same window. Everything outside it — the
conversation upsert, the participant upserts, the touchpoint writes — is keyed, deduped and
ordered *before* the commit, so a crash can only cause repeated work, never lost work. Safety
caps bound one sweep's work at 20 chat pages per account and 10 message pages per chat; a chat
further behind than that keeps its advanced cursor *and* its old watermark, so it stays eligible
and finishes catching up on the next sweep instead of being skipped as caught-up.

No AI provider call happens anywhere on this path. Ingestion is deterministic.

**An empty first page is retried once, not marked done (#81).** A brand-new chat's first sweep
takes exactly one page in the newest-first (`before`) direction. The sweep withholds the cursor
and watermark the first time that page comes back with zero messages, so the next sweep retries
the same page; if the retry is *also* empty, the real watermark commits (so a genuinely
history-less chat still reaches a stable, not-re-swept state) and one warn-level log line records
it — chat id only, no content. **This retry does not reach every empty chat.**
`chatNeedsSweep` only re-selects a chat once Beeper reports it as active again, and a live-instance
investigation found its *entire observed population* of empty chats were ones Beeper itself never
reports any activity for at all — not a message-kind filter (there is none) and not the safety
caps above (they only bound the forward catch-up walk on a chat that already has a stored cursor).
Those chats are swept exactly once and then correctly left alone; the retry instead covers a chat
whose activity IS real but whose first page still came back empty (a transient fetch hiccup, or a
history-less chat gaining its first-ever activity right as it enters the mirror).

**Sort order: an activity-less chat sorts last, not by when the mirror happened to sweep it
(#81).** The list ordering used to fall back to the conversation row's `created_at` for a chat with
no real Beeper activity. Every row in a fresh mirror is minted in the same short sweep window, so a
whole batch of activity-less chats shared a recent `created_at` and sorted at the **top** of the
Inbox, above populated threads with older real activity — this, not a mirroring gap, is what
actually produced the reported symptom for the observed population above. The fallback is now
`'epoch'::timestamptz` instead of `created_at`: older than any real timestamp, so an activity-less
chat sorts **last** under the existing `DESC` order rather than wherever its row happened to be
created. The network rail's own last-activity aggregate is a plain `MAX(c.last_activity)` — no
`created_at` fallback and no epoch sentinel, since `MAX` already ignores `NULL`s and returns `NULL`
when every conversation in the network has none, which is the honest answer.

**The Inbox row while a chat is still catching up.** `beeper_conversations.last_activity` is
Beeper's own chat-level watermark, mirrored independently of whether any message has actually
been mirrored — so a row can carry a recent `last_activity` while `lastMessage` is still `null`.
Beeper's own `Chat` payload carries no preview or snippet text to show in that gap, so the rail
row (`BeeperChatSurface.jsx`) reads it off `last_activity` instead: a conversation with no
mirrored message and a `last_activity` inside the last 24 hours shows **"Syncing…"**; anything
older, or with no `last_activity` at all, keeps the honest **"No messages mirrored yet"** copy.
This only changes what an empty row *says*; the sort fix above is what changes *where* it sits.

**What is mirrored:** accounts, conversations, messages, participants, attachment *metadata* and
per-chat sync cursors, across eight `beeper_*` tables. **What is not:** `loginID` is stripped
from every account and bridge row before it reaches any caller (it is the bridge login
credential's own id — a phone number), and `activeAccountCount` is dropped because it is
documented to over-report. Beeper's own `isPinned` is mirrored rather than duplicated: PortOS
stores no pin of its own, and there is deliberately no route to set one. Deletions from the
source are tombstones, not removals — a message the source unsends keeps its row, body and
attachments and gains `unsent_at`.

**Tribe linking** relates a `beeper_participants` row to a `tribe_people` row by durability of
handle: a phone or a network username resolves through `tribe_identities` (plus the existing
Tribe phone matcher for a phone), and resolution only ever *matches* an existing person, never
creates one, so the automatic path cannot produce a duplicate. A participant with no durable
handle is linked by hand, and the participant upsert never touches `tribe_person_id`, so a
manual link survives every re-sync. Group touchpoints are derived from message **senders**, never
from the participant roster, because Beeper truncates that roster (20 in a list, 100 on a single
GET, no cursor) and iterating it would invent contact with people who never messaged.

**Every manual link is durable across a purge + resweep**, including for the roughly one in eight
counterparties Beeper reports neither a phone nor a username for. Linking claims a
`kind='beeper-user'` row in `tribe_identities` keyed on the participant's own Beeper **account id
and user id** (`beeper_conversations.account_id` + `beeper_participants.source_user_id`, both
joined server-side, never client-supplied) — a pair Beeper keeps stable across resweeps, where
the mirror's own `conversation_id` is a PortOS UUID re-minted by every purge. `tribe_identities`
has no foreign key onto anything Beeper-side, so purging a conversation cannot cascade the link
away with the participant row; the first re-observation after the resweep re-fills
`tribe_person_id` from the claim. Resolution order is: the handle claim, then the beeper-user
claim, then the cached column, then the legacy Tribe phone matcher. Re-linking the same
participant to the same person is a no-op; re-linking to somebody else moves the claim and clears
the displaced person's stale caches, the same "last explicit link wins" rule the handle axis
follows. Installs that made such links before this shipped are promoted by an idempotent backfill
that runs with the boot-time schema DDL (soft-deleted people are skipped).

**The Tribe link surfaces beside the thread title** (fork issue #98), not only inside the
participants drawer. `BeeperThread.jsx`'s header renders a small chip next to the title, branching
on the mirrored `conversation.isGroup` (Beeper's own `chat.type === 'group'`), never on
participant count:

- **1:1** (`isGroup: false`) — the counterpart is simply the conversation's own participant list
  (see `oneToOneCounterpart` in `BeeperThread.jsx`: Beeper's own roster for a `single` chat never
  includes the local account's user, so the roster IS the counterpart; there is no per-participant
  self/`isSender` marker anywhere in the mirrored schema to check instead, and no account user id
  reaches the client). Linked shows **"<name> · Tribe"** and clicking it opens `/tribe?person=<id>`
  directly; unlinked shows **"Link to Tribe"**, which opens the participants drawer (the same panel
  the existing "People" button opens).
- **Group** (`isGroup: true`) — a participant-count chip (e.g. "6 people", or "20+ people" once
  `hasMoreParticipants` is set, matching the drawer's own truncation caveat), which also opens the
  drawer. A group never shows a single link state — there is no one counterpart to link.

**The participant-linking control is a search-first picker**, not a full-roster `<select>`.
`BeeperPersonPicker.jsx` (beside `BeeperThread.jsx`, with its own test file) is a combobox: type to
filter (client-side, debounced ≥200ms, over the roster the surface already loads once per mount —
the server's `GET /tribe/people?search=` param stays available for a future caller with a roster
too large to hold client-side), navigate results with ArrowUp/ArrowDown, and Enter/click selects.
Selecting a result **is** the link action — there is no separate "Link" button afterwards. **"Create
new…" is always the picker's last row**, below every match, and opens `BeeperCreatePersonForm.jsx`
(beside `BeeperThread.jsx`, its own component with its own test file) in place of the picker (fork
issue #97 part A) rather than posting immediately: a name input prefilled from the participant's own
`displayName || handle` (editable, required), a ring `<select>` built from the same `RINGS` list
(`client/src/lib/tribe.js`) the Tribe page's own person editor renders, and an optional relationship
input. Enter submits, Escape cancels. Only its Create button — disabled while the name is blank or a
link is in flight — calls `onCreateAndLinkParticipant` with `{ name, ring, relationship }`, the exact
fields `POST /tribe/beeper/link-new`'s `beeperCreateAndLinkSchema` already accepted; Cancel returns
to the picker having posted nothing.

**A linked participant offers Change and Unlink, not just a static label** (fork issue #97 part B) —
until now, a mistaken "New" or a wrong pick from the picker was permanent from this panel. Both sit
beside the "Linked · &lt;name&gt;" row (`ParticipantRow`'s own `mode` state in `BeeperThread.jsx`):

- **Change** reopens the exact same search-first picker in the row, pre-focused (`autoFocus` on
  `BeeperPersonPicker`), so re-pointing the link is a single selection; "Create new…" inside it opens
  the same confirm-and-rename form as the unlinked path. Choosing a person calls the SAME
  `onLinkParticipant` / `POST /tribe/beeper/link` a fresh link uses — verified safe to reuse rather
  than unlink-then-link: `linkParticipant`'s `tribe_identities` writes are `ON CONFLICT ... DO
  UPDATE`s that move the SAME row's `person_id` in place, so re-linking to someone else leaves no
  stale claim on the old person for this participant. "The last explicit link wins" already meant one
  row per identity, never two, so a plain re-link is a complete, correct Change on its own.
- **Unlink** calls the new `DELETE /tribe/beeper/link` (body `{ conversationId, sourceUserId }`) →
  `beeperTribe.unlinkParticipant`, which deletes every `tribe_identities` claim the CURRENTLY-linked
  person holds for this participant — the handle claim from `identityScopeFor` and/or the
  `kind='beeper-user'` claim from `beeperUserScopeFor` — each filtered on that person's own id, so a
  claim someone else now holds on the same handle is never touched. It then nulls the participant's
  own cache column and every other participant row those claims were backing, reusing the same
  `clearDisplacedParticipantCaches`/`clearDisplacedBeeperUserCaches` helpers a displaced-owner re-link
  already relies on, with the unlinked person simply standing in as the "displaced" one. Idempotent:
  unlinking an already-unlinked participant is a 200 no-op (`unlinkedPersonId: null`), and a genuine
  unlink emits the same `tribe:changed` socket event the link routes do.

**`Tribe.jsx` accepts a `?person=<id>` deep link.** On load, and whenever the param changes, the
page switches to the Circle tab, selects that person through the exact same path a click on their
`ContactCard` takes (`selectContact`), and scrolls the card into view — the same shape the existing
`?outreach=<conversationKey>` deep link (Care Queue) already uses. An id the roster does not
recognize (a deleted person, or a stale bookmark) is silently ignored, with no error toast. Both the
title chip's linked state and the participants drawer's "Linked · <name>" row (now a link, not plain
text) point here.

**The Tribe person form shows every linked identity.** `GET /tribe/people/:id` (only the
single-person read — the roster never pays this join) attaches `identities: [{ kind, network,
handle, linkedAt, source, conversations }]`, one entry per `tribe_identities` claim, each carrying
the Beeper conversations it appears in. A `beeper-user` claim's conversations come from joining
`beeper_participants`/`beeper_conversations` on the claim's own (account, `source_user_id`) key;
a `handle`/`phone` claim's come from the resolved participant cache
(`beeper_participants.tribe_person_id`), scoped to the claim's network for a `handle` and
left unscoped for a network-less `phone`. A purged conversation or a participant whose cache was
cleared by a later re-link simply contributes no conversation entry — nothing to special-case. The
Tribe person form's "Linked on Beeper" block renders one chip per identity — network plus handle
or participant display name — each conversation linking to `/messages/beeper/<conversationId>`,
with an Unlink action (`DELETE /tribe/beeper/identities/:identityId`) that removes the claim and
nulls the cache rows it was backing. Notes no longer carries the network: a fresh Beeper import
sets `notes` to the plain "Imported from Beeper" and leaves the network entirely to this block, so
a second network linked later never leaves a stale first-network mention behind (existing notes
are untouched).

### Unread badge

`beeper_conversations.unread_count` is Beeper's own count, mirrored verbatim and overwritten
wholesale by every sweep — so opening a thread in PortOS cannot clear it by zeroing that column
directly; the very next sweep would put it right back. Fork issue #83's fix is a second, LOCAL
column instead: `seen_at`, stamped with the server's own clock (`markConversationSeen` in
`server/services/beeper/beeperConversations.js`) when the chat surface opens a thread, and again, cheaply,
whenever a new message lands in a thread that is already open. Every read path that shows an
unread count — the row badge, `unreadOnly` in `GET /api/beeper/conversations`, and both aggregates
`GET /api/beeper/networks` returns — treats a conversation as read when `seen_at` is at or after
its own `COALESCE(last_activity, created_at)`, and as unread again the moment newer activity lands,
with no separate bookkeeping. Because the comparison happens at read time against a column the
sweep never touches, the watermark survives every sweep by construction rather than by racing one.

**Read receipts are off by default.** Opening a thread only updates its local watermark
unless **Send read receipts to Beeper** has been enabled in settings after the explicit consent
step. With that opt-in, opening a thread with unseen activity also makes a best-effort read
receipt call; a Beeper failure does not undo the local seen state.

### Later scope

The **Later** rail button shows conversations whose mirrored Beeper snooze deadline is still
in the future. Snoozes are set or cleared in Beeper Desktop; this scope does not create a separate
PortOS snooze state. The existing sync sweep refreshes snooze state even when a conversation has
no new messages. Older Desktop versions that omit snooze state produce an empty Later list.
Expired deadlines are excluded when the list refreshes through the existing sweep/invalidation
flow. Search, unread filtering, saved scopes, pagination, and shared `?scope=later` links work
with this scope. Other scopes keep their existing filters.

### Attachments

The byte mirror is **lazy**. Ingestion writes the attachment's metadata and its durable `mxc_id`
reference; the bytes arrive only when a human opens the thread that shows them. A mirrored
account's attachment history runs to gigabytes, and fetching all of it is a transfer nobody
asked for. A bulk backfill exists, but it is a user action behind a consent step that names the
count and the byte size first, and it stops at the disk budget rather than blowing through it.

Files are **content-addressed** at `data/beeper/attachments/<sha256[0..2]>/<sha256>.<ext>`, so
one photo forwarded into four chats is one file and four rows — which is why every deletion path
runs a reference check before unlinking. The extension is cosmetic: `GET /v1/assets/serve` sends
no `Content-Type` at all, so the row stores Beeper's declared `mimeType` and the serving route is
handed that explicitly rather than letting anything be sniffed out of a filename.

- **Per-attachment ceiling: 32 MiB** (`BEEPER_ATTACHMENT_MAX_BYTES`), matching the ceiling PortOS
  already uses for a single federated media asset. It is a named constant, not a setting: an
  over-cap attachment is not lost, it keeps its row and offers "fetch anyway", which is the
  escape hatch a knob would otherwise have been. The cap is enforced at the `HEAD` pre-flight
  *and* mid-stream, because a bridge that declines to report `Content-Length` would otherwise get
  an unbounded write past a ceiling the pre-flight could not see.
- **Disk budget: `settings.beeper.attachmentBudgetGb`**, 5 GB by default, 0.1–1000 accepted.
- **Eviction** is least-recently-viewed, at most 50 candidates per sweep, and it skips anything
  the user locked with `keep`. Before evicting, it `HEAD`s the source: a 502 means Beeper can no
  longer supply the file, so the local copy is the last one in existence and is **kept**
  regardless of age and stamped `unavailable_at` so nothing re-probes it. Any *other* probe
  failure (Beeper closed, a transport blip) stops the sweep rather than evicting on an unanswered
  question, and a row with no `mxc_id` is never a candidate at all, because eviction is only safe
  when the file can be fetched again.
- The same six-hourly sweep also runs an orphan backstop (a file no row points at, a row whose
  file is gone, an abandoned `.partial` older than an hour). It runs whether or not scheduled
  sync is on, because bytes already on disk still count against the budget.
- A stalled transfer is bounded by **silence**, not elapsed time: 60 seconds without a chunk
  aborts, so a slow but progressing 32 MiB download is never cut off and a dead one is.

Bytes are served from an authenticated `/api/` route (`GET /api/beeper/attachments/:messageId/:idx`),
never a static `data/` mount — message media is PII and the store is a pile of hashes that a
directory mount would expose without the row-level check the route performs.

**Data Manager's `beeper` category (`server/services/dataManager.js`) is size-only** —
`deletable: false`, no `purgeScope`. `data/beeper/` holds one subdirectory, `attachments/`, so the
generic purge control was never actually reachable: a category-wide wipe needs `purgeScope:
'category'`, and the per-item form refuses a directory entry outright (it removes a single file
and never recurses). Reclaiming space runs through the two paths above that reference-check
before touching a byte instead: the attachment budget sweep (least-recently-viewed eviction,
bounded by `settings.beeper.attachmentBudgetGb`) and the per-conversation purge
(`DELETE /api/beeper/conversations/:id`, content-addressed so a photo forwarded into other chats
survives one conversation being purged).

### Realtime

`server/services/beeper/beeperSocket.js` holds one long-lived WebSocket from the PortOS server to
`/v1/ws`. The browser cannot hold it: Beeper binds to loopback with CORS locked to the machine,
and a browser cannot set an `Authorization` header on `new WebSocket()`. It uses the `ws`
package rather than Node's built-in WebSocket because a protocol-level server ping is the only
liveness signal Beeper offers and the built-in does not surface ping frames to application code.

On `ready` the transport sends one `subscriptions.set` for `chatIDs: ['*']` plus app state, and
never re-subscribes per conversation: `subscriptions.set` replaces state wholesale and the window
during a re-set is dark, so scoping it would manufacture a loss window on exactly the event you
most want to catch.

- **Silence watchdog:** 75 seconds (2.5 missed server pings) without any inbound signal tears the
  socket down and reconnects. Reconnect backoff runs from 1 s to a 60 s ceiling; after the first
  three attempts only every tenth is logged, because Beeper Desktop simply being closed is the
  common case.
- **The socket asks the sweep to run early** on the three occasions frames could have been lost:
  a reconnect, a `seq` gap, and a recovery from an actionable `app.state`. The first connection of
  a process is not a reconnect and fires nothing.
- **It is never gated on `app.state`.** A live probe caught `initializing` reported for 105
  continuous seconds while every bridged account was connected and a chat page returned in
  230 ms. It is a display input for the status card, never a gate.
- The transport arms on the feature-plus-token gate alone, without the ingestion opt-in: holding
  the socket open writes nothing, and the liveness dot it feeds is precisely the surface a user
  needs while deciding whether to turn ingestion on. With the ingestion toggle off it connects,
  subscribes and relays invalidations, and writes no conversation or message body.

**The relay to the browser is invalidation-only.** `server/services/beeper/beeperSocketEvents.js` is a
leaf event bus; `socket.js` bridges it onto Socket.IO and broadcasts to the `beeper` subscriber
set — never `io.emit`, because the peer relay opens a Socket.IO client to every online peer and a
global emit would cross the wire to other installs. Frames carry ids, kinds and transport
liveness. They never carry message bodies, display names or handles; the browser refetches from
the PortOS mirror, which is the read path.

### Sweep visibility and the list header

Before fork issue #80, nothing on screen distinguished "connected, first sync running" from
"nothing connected" — the empty inbox told a user who had just connected nine accounts to go
connect one. Two pieces close that gap:

- **`server/services/beeper/beeperSweepProgress.js`** is a small standalone leaf module (same reason
  `beeperSocketEvents.js` is one: a read-only status route has no business importing the sweep's
  whole DB/HTTP dependency graph just to report a few numbers) holding one in-memory, process-wide
  snapshot: `running`, `startedAt`, `finishedAt`, `reason`, `accountsDone`, `accountsTotal`,
  `chats`, `messages`. `executeSweep` in `beeperSync.js` updates it as it goes — `running: true`
  before the first HTTP call, `accountsTotal` once the roster is known, `accountsDone`/`chats`/
  `messages` after every account, `running: false` in a `finally` so a thrown `NOT_CONFIGURED` or
  `SWEEP_FAILED` still flips it back. `beeperStatus.js` reads it into `GET /api/beeper/status`'s
  `sweep` field (see [API surface](./beeper.md#api-surface)).
- **The sweep fires an invalidation frame** — the exact `{ kind, chatID, ids, seq, ts }` shape
  #33's realtime relay already uses, with `kind: 'beeper-sweep'` and `chatID: null` — once the
  account count is known and again after every account finishes, reusing `beeperSocketEvents`
  rather than opening a second channel. `BeeperTab.jsx` already re-fetches `GET
  /api/beeper/status` on every invalidation frame (the same fetch that seeds the realtime dot and
  the outbox breaker flag), so the list header's strip and the settings drawer's status card both
  move as the sweep progresses with no separate poller anywhere.

The list header (`BeeperChatSurface.jsx`) renders `"Syncing… N of M accounts"` while `sweep.running`
is true and `"Last synced HH:MM"` (from `sweep.finishedAt`) once idle; nothing before a sweep has
ever run. The settings drawer's status card shows the identical two lines beside the realtime dot.
The empty state also branches on `tokenConfigured` rather than on `networks.length` alone:
connected but nothing mirrored yet reads **"First sync in progress"**; never connected keeps the
"Open Beeper settings" prompt.

**"Sync now"** replaces what used to be a plain refresh button (fork issue #79): the list header's
icon button now calls `POST /api/beeper/sync` first and re-fetches the conversation list and the
network rail once that resolves (`skipped: true` — a sweep already in flight, most likely the
scheduled one — still triggers the re-fetch, since whatever that sweep already wrote is worth
showing).
