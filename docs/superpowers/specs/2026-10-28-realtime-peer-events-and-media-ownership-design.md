# Realtime peer events, durable media deletes, and multi-host media ownership

## Why

A video deleted on one PortOS instance still appears in the Media History list on a
federated peer. Two root causes, both in the current sync design:

1. **Deletes are unrepresentable.** `video-history.json` syncs as a union-merge by row `id`
   (`applyVideoHistoryRemote` in `server/services/dataSync.js`, "append-mostly and immutable").
   `deleteHistoryItem` (`server/services/videoGen/historyOps.js`) just filters the row out.
   No tombstone exists, so a peer that still holds the row keeps it and re-merges it back.
   Image history very likely has the same gap (verify).
2. **Peers cannot manage each other's assets.** Deleting a host-owned item on a peer removes only
   the peer's copy; the host never hears about it and its next snapshot re-adds the row.

Sync today is a 60s snapshot loop (`SYNC_INTERVAL_MS` in `server/services/syncOrchestrator.js`).
The owner wants peers to push realtime events instead of polling, with periodic sync demoted to a
safety net. Separately, the owner is moving to a default of **not copying media renders**:
content is owned and hosted on peers, so the UI must show where each item lives, show when an item
lives on several machines, and let the owner make one host primary and delete the other copies.

## Goals

- A create/update/delete of a synced media-history record reaches every online peer within about a
  second, applied without waiting for the snapshot loop.
- A delete is durable: an offline peer learns of it on reconnect or on the next safety-net sync, and
  no peer ever resurrects the row.
- Deleting an item on any peer deletes it for real (files and row) on the host(s) that own the
  bytes. Paired peers are trusted entities; the owner administers media across them.
- Every history card shows which machine hosts the item, and shows when more than one machine holds it.
- "Make primary" on a multi-host item keeps one host and deletes the copies elsewhere.
- New peers default to not copying media (`mediaSyncMode: 'host'`).

## Non-goals

- Moving every sync category (brain, goals, meatspace, ...) onto the event channel. The channel and
  tombstone mechanism are generic, but only **video history and image history** migrate now. Other
  categories migrate later, one at a time.
- Removing the periodic snapshot sync. It stays as the reconciliation path, at a lower frequency.
- Changing existing peers' `mediaSyncMode`. The new default applies to newly paired peers only.
- Any exposure of PortOS to the public internet, or multi-tenant defenses (see AGENTS.md Security Model).

## Anti-goals (failures even if it "works")

- A delete that a peer's snapshot can undo.
- A peer-initiated delete that removes only the local copy and reports success.
- Event payloads that carry credentials, machine-local settings, or data outside the existing
  per-peer / per-category federation controls.
- An unbounded or unauthenticated event path: peer sockets are currently restricted to
  `cos:subscribe`/`cos:unsubscribe` (`PEER_RELAY_ALLOWED_EVENTS` in `server/services/socket.js`);
  the new events extend that allowlist explicitly, they do not widen it generally.

## Existing pieces this builds on

- `server/services/peerSocketRelay.js`: Socket.IO client to each online peer, authenticated with the
  same pair credential as `peerFetch` (`peerSocketOptionsFor`). Currently carries `cos:agent:*` only.
- `server/lib/tombstones.js`: timestamped tombstones, bidirectional union, re-create supersession,
  capped list. `tombstoneGc.js` sweeps them on a grace period.
- `server/services/peerHostedMedia.js`: machine-local index of which peer hosts which file, used
  only for `mediaSyncMode: 'host'` peers; local file always wins. Not federated.
- `server/services/peerAdministration.js` / `server/lib/peerAdminValidation.js`: grant-based peer
  admin, **planning-only today** (no executor registered; actions are `portos.update`,
  `portos.restart`, `catalog.install`). Remote media delete needs a new action and executor.
- `server/lib/syncManifest.js`, `syncWire.js`, `schemaVersions.js`: wire contracts. Cross-machine
  payloads stay version-gated so an older peer is not corrupted.

## Project 1: realtime events, tombstones, remote delete (build first)

### Event channel
- Add a small event vocabulary on the existing peer socket link, e.g. `peer:sync:upsert`,
  `peer:sync:delete` carrying `{ category, id, record?, tombstone?, originInstanceId, schemaVersion }`.
  Name and exact shape are the builder's call, but they must be version-gated.
- The originating machine emits to all connected peers after a local mutation commits (video/image
  history write paths: generation completion, delete, hide-independent metadata edits that already
  sync). Receivers apply through the same merge function the snapshot path uses, so there is one merge
  implementation, not two.
- Server side, extend the peer-socket allowlist for exactly these events. Per-event auth recheck
  (`socket.js` already re-checks per event) must still apply, and payloads from peers are untrusted
  input: validate with Zod, cap size, ignore unknown categories.
- Emission is fire-and-forget with no ack requirement. Dropped events and offline peers are covered
  by the safety net.

### Safety net
- Keep `syncAllPeers` and the on-`peer:online` immediate sync. Lower the interval frequency for the
  migrated categories (builder to choose a value; recommended minutes, not seconds) and keep the
  60s tick for categories not yet migrated.
- Snapshots for video/image history include the tombstone list so a peer offline during the delete
  converges on reconnect.

### Tombstones for media history
- Key: row `id` (same on every machine; rows are union-merged by `id` today). Use `tombstones.js`
  semantics including re-create supersession.
- `deleteHistoryItem` (video) and the image equivalent record a tombstone, then emit
  `peer:sync:delete`. Merge functions drop tombstoned rows and prune superseded tombstones.
- Snapshot checksum must stay stable: tombstones included in the checksum input deterministically
  (sorted), so peers converge rather than re-download forever (see the existing #4115 note).

### Remote (admin) delete
- A peer deleting an item whose owner is another machine sends a delete **command** to the owner
  (HTTP via `peerFetch`, or the socket link; builder's call), then applies the tombstone locally. The
  owner performs the full `deleteHistoryItem` (trash files, derived index row, music-video forget) and
  emits the tombstone to everyone.
- Authority: paired peers are trusted, so this does not use the human-approved, time-boxed grant
  flow in `peerAdministration.js`. **My call (flagged for review):** add a new standing capability
  `media.delete` checked against the pair credential, with a per-peer on/off setting that defaults to
  on for paired peers (owner said peers are trusted admins). Refusal returns a clear error and the
  UI must not show a successful delete. Builder should confirm this against the Security Model
  section on delegated authority and add both a refusal test and an authorized-workflow test.
- If the owner is unreachable, the peer records the tombstone locally, queues the command, and
  retries when the owner reconnects. UI shows "delete pending on <peer>".

## Project 2: ownership and visibility (after 1)

- Add `originInstanceId` to new video/image history rows at creation. Backfill existing rows: a row
  created locally gets the local instance id; a row received from a peer gets that peer's id where
  the supplying peer is knowable (e.g. via `peer-hosted-media.json` for host-mode peers, or the
  sync source recorded at merge time). Rows whose origin cannot be determined get no badge and are
  never auto-targeted by remote delete (fail closed). Backfill ships as a numbered migration in
  `scripts/migrations/` (see AGENTS.md migrations rules; it derives from existing records so it
  ships no `data.reference/` seed).
- Add a **holders** notion: the set of instance ids that currently hold the bytes for a row.
  Machine-local view is derived (local file exists, `peer-hosted-media.json` entry); the federated
  view is reconciled from peers announcing "I hold / no longer hold <id>" via the same event channel
  and the snapshot. Exact storage is the builder's call under `docs/STORAGE.md`.
- UI: `MediaCard.jsx` / `MediaHistoryGrid.jsx` show a host chip: nothing for items hosted only here
  (or a subtle "This machine"), "Hosted on <peer name>" for a single remote host, and
  "N hosts" with a detail popover listing machines when more than one holds it. Peer name resolves
  from instance id via the peer registry. Realtime updates via the socket events, no polling.
- Hosting is shown for both `host` and `copy` modes. Items copied locally still show their origin.

## Project 3: multi-host management (after 2)

- "Make primary" action on a multi-host item (card/lightbox). Server flow: verify the chosen host
  holds the bytes, then send the remote delete (project 1) for the copies on every other host, then
  update holders. The UI lists exactly which copies will be deleted and requires in-app confirmation
  (not `window.confirm`).
- Primary designation is a field on the row (e.g. `primaryInstanceId`) that syncs; it determines
  which holder serves the bytes and which is targeted by future default behavior.
- Default `mediaSyncMode` for newly paired peers becomes `host`. Existing peers untouched.
- A copy delete that fails (peer offline) stays queued and visible; the item shows as still multi-host
  until the peer confirms.

## Constraints

- Backward/forward compatibility across installs is first-class: version-gate all new wire fields
  (`server/lib/schemaVersions.js`); an older peer must ignore events and tombstones it doesn't understand
  without corrupting local data. On-disk changes need migrations.
- No new polling (AGENTS.md "Push, don't poll"). Client updates come from socket events.
- Every deletion path must use the existing trash behavior (`trashFiles`), not hard-delete.
- Tests per `AGENTS.md` strategy: public-boundary tests for the delete round-trip across two
  simulated peers (delete here -> row gone there; offline peer converges via snapshot; re-create after
  delete is not suppressed; peer-initiated delete lands on owner; unauthorized sender refused).
- Single-user trust model: no multi-tenant defenses, but serialize operations that can overwrite the same record.
- Run `npm run pregate` before pushing; follow repo git workflow. Do not commit or push without being asked.

## Left to the builder

Event names and payload shape; interval values; holders storage location; whether remote delete rides
HTTP or the socket; retry/queue mechanics for the offline owner; the exact UI layout of the chip and popover.

## Resolved after builder check (my calls)

- **Origin ships in Project 1, backfill in Project 2.** New video/image rows get `originInstanceId`
  at creation from Project 1 on, because remote delete needs it. Project 2 only backfills old rows.
- **Delete target set.** The command goes to the row's origin if known and online; otherwise to every
  known holder (origin, `peer-hosted-media.json` entries, and the peer that supplied the row at merge
  time, which Project 1 starts recording). A peer with none of these knowable cannot remote-delete the
  row: it hides it locally and shows an explicit "owner unknown" notice. Fail closed.
- **No false success, no unauthorized fan-out.** When the row is owned elsewhere, the initiating peer
  hides it locally in a local-only *pending* state and does NOT emit a tombstone. The owner executes
  the delete, then emits the tombstone to everyone. A peer may emit `peer:sync:delete` only for rows it
  owns; receivers accept a delete tombstone only from a paired peer with `media.delete` that is the
  row's origin or a known holder, and ignore others. A refused or failed command un-hides the row
  and surfaces the error.
- **Id reuse.** History ids are job ids and are not reused; keep `tombstones.js` supersession on
  `createdAt` anyway as the safe default. Builder verifies there is no restore-from-trash path into
  history; if there is, restore clears the tombstone.
- **Image history.** Builder verifies its sync path first. If it differs from video's, it gets the same
  mechanism in a second PR still inside Project 1.
- **Offline command queue.** Persisted per peer until acknowledged; dropped after 30 days, on unpair,
  or if the row is re-created. UI shows "delete pending on <peer>" with a cancel action.
- **Make primary and local copies.** If the chosen primary is remote and this machine holds a copy,
  the local copy is deleted too, after `peer-hosted-media.json` is seeded so the item streams from the
  primary. Make primary is refused while the chosen host is unreachable.

## Open calls to review (mine, not the owner's)

1. Standing `media.delete` peer capability, default on for paired peers. **Owner confirmed:** it also
   turns on automatically for already-paired peers on upgrade (a migration sets it, with a per-peer
   off switch in settings).
2. Fail closed on rows with unknown origin: no badge, no remote delete.
3. Only video and image history migrate to events now.
4. New-peer default `mediaSyncMode: 'host'` only affects newly paired peers.

## Amended after the final branch review

- **The origin is the authority for a delete.** When the row's origin is registered but unreachable,
  its command is queued even if another holder already deleted its copy, and the delete reports
  pending until the origin acks. An unpaired origin refuses the delete (409).
- **Rows no registered peer can own are deleted locally.** A row whose origin peer was removed, or
  that has no origin and no registered holder, is deleted here like a local row instead of only being
  hidden. Hide-only ("owner unknown") is left for rows whose every asked holder says it holds none.
- **Restore paths keep the tombstone for now** (#14087), and pre-upgrade media without an origin
  does not propagate deletes until the backfill (#14089).
