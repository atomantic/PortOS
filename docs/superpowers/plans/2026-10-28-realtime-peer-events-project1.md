# Realtime Peer Events, Durable Media Deletes, Remote Delete — Project 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A media delete made on any peer removes the item for real on its owning host and on every peer, in about a second, and can never be undone by a snapshot merge.

**Architecture:** Peer sockets already exist (`peerSocketRelay.js`: each machine is a Socket.IO *client* of every online peer, authenticated with the pair credential). The server side broadcasts `peer:sync:event` frames to relay sockets that sent `peer:sync:subscribe`; the receiving relay validates and applies them through the same merge code the snapshot loop uses. Deletes are timestamped tombstones (`server/lib/tombstones.js`) stored beside the history file and carried both in events and in the video-history snapshot. A delete of a row owned elsewhere is an HTTP command to the owner; the owner deletes and emits the tombstone.

**Tech Stack:** Node/Express, Socket.IO (server + `socket.io-client`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-realtime-peer-events-and-media-ownership-design.md` (Project 1 + "Resolved after builder check"). Projects 2 and 3 are out of scope here.

## Global Constraints

- No new polling; client UI updates from socket events (AGENTS.md "Push, don't poll").
- All new wire fields are version-gated via `server/lib/schemaVersions.js`; an older peer must ignore unknown events/tombstones without data loss.
- Deletes use `trashFiles` (never hard delete). Reuse `deleteHistoryItem` (`server/services/videoGen/historyOps.js`) and `deleteImage` (`server/services/imageGen/local.js`).
- Peer-sent payloads are untrusted: Zod-validate, cap size, ignore unknown categories. Never log full JSON; emoji single-line logs; `console.error` only for real failures.
- `media.delete` is a standing per-peer capability, default on for new AND already-paired peers (migration), with a per-peer off switch. Refusal must be explicit (403 `MEDIA_DELETE_FORBIDDEN`), never a silent local-only delete.
- Rows owned elsewhere: initiator hides locally in a local-only *pending* state and does NOT emit a tombstone; only the owner emits. Fail closed when the owner is unknowable.
- New public modules in `server/lib/` need an `index.js` export plus a `README.md` row. Tests live beside source. Use placeholder data only.
- Do not commit/push unless asked; run `npm run pregate` before any push.

## Review Focus

- Peer offline during the delete, then reconnects: converges via snapshot, row not resurrected.
- Row deleted, then legitimately re-created with a newer `createdAt`: not suppressed.
- Event for an unknown category, oversized frame, or malformed record: ignored, no throw, relay stays up.
- Delete event from a peer that is neither the row's origin nor a holder: ignored.
- Owner refuses (capability off) or is unreachable: initiator's row reappears or shows "pending", never shows deleted.

---

### Task 1: Media tombstone store

**Files:**
- Create: `server/services/mediaTombstones.js`, `server/services/mediaTombstones.test.js`

**Interfaces:**
- Consumes: `server/lib/tombstones.js` helpers (`mergeTombstones`, `isTombstoned`, `pruneTombstones`), `readJSONFile`/`atomicWrite`, `createFileWriteQueue`.
- Produces:
  - `recordMediaTombstone(kind: 'video'|'image', key: string, deletedAt?: string): Promise<Tombstone>` (key = row `id` for video, filename for image)
  - `listMediaTombstones(kind): Promise<Tombstone[]>`
  - `mergeMediaTombstones(kind, remote: Tombstone[]): Promise<{ added: Tombstone[] }>` (union; idempotent)
  - `isMediaTombstoned(kind, key, liveStamp?: string): Promise<boolean>`
  - Persistence: `data/media-tombstones.json` `{ version: 1, video: [...], image: [...] }`, strict read like `peerHostedMedia.js` (unreadable never overwritten as empty).

- [ ] **Step 1: Write failing tests** in `mediaTombstones.test.js` (temp data dir): `records and lists a tombstone`, `merge is idempotent and unions both sides`, `a row whose createdAt is newer than the tombstone is not tombstoned`, `unreadable file rejects instead of resetting`.
- [ ] **Step 2: Run** `npm test --prefix server -- mediaTombstones` → FAIL (module missing).
- [ ] **Step 3: Implement** the four functions above in `server/services/mediaTombstones.js`, serialized through one `createFileWriteQueue()`, capped by `DEFAULT_TOMBSTONE_LIMIT`.
- [ ] **Step 4: Run tests** → PASS. Add the file's row to nothing (services dir has no catalog barrel; confirm with `rg -n "services" server/lib/index.test.js`).

---

### Task 2: Video delete is durable (tombstone + merge + snapshot)

**Files:**
- Modify: `server/services/videoGen/historyOps.js` (`deleteHistoryItem`), `server/services/dataSync.js` (`getVideoHistorySnapshot`, `applyVideoHistoryRemote`, ~lines 880–1000), `server/lib/schemaVersions.js`
- Test: `server/services/dataSync.videoHistoryTombstone.test.js` (new)

**Interfaces:**
- Consumes: Task 1 functions.
- Produces: video snapshot `data` gains `tombstones: Tombstone[]` (sorted deterministically, included in checksum); `applyVideoHistoryRemote` merges incoming tombstones first, drops tombstoned local and incoming rows, and trashes local files of a row removed by a remote tombstone via `deleteHistoryItem(id, { fromRemoteTombstone: true })` (which must not re-record or re-emit).

- [ ] **Step 1: Write failing tests**: `deleting a video records a tombstone`; `snapshot from a peer with a tombstone removes the local row and files`; `peer snapshot without the tombstone does not resurrect a deleted row`; `re-created row with newer createdAt survives`; `checksum is stable across tombstone insertion order`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the changes above. `deleteHistoryItem` calls `recordMediaTombstone('video', id)` inside its existing lease. Bump the video-history entry in `schemaVersions.js` and document that older peers ignore `tombstones`.
- [ ] **Step 4: Run** `npm test --prefix server -- dataSync.videoHistory` (all existing `dataSync.videoHistoryHosted` tests still pass) → PASS.

---

### Task 3: Origin and supplier stamping

**Files:**
- Modify: video row creation path (find with `rg -n "unshift|saveHistory" server/services/videoGen/generateVideo.js server/services/videoGen/videoDownload.js`), `applyVideoHistoryRemote` in `dataSync.js`
- Test: `server/services/videoGen/originStamp.test.js`

**Interfaces:**
- Produces: new local rows carry `originInstanceId` (local id from `instanceIdentity.js`); rows added by a peer merge carry `suppliedByInstanceId = source.peerId` when absent. Both fields sync with the row. Helper `rowOwnerCandidates(row, hostedIndex): string[]` in `server/lib/mediaRowOwners.js` returns, in order, `originInstanceId`, entries from `peerHostedMedia` for the row's filename, then `suppliedByInstanceId`, de-duplicated; empty array means owner unknowable.

- [ ] **Step 1: Write failing tests**: `new generated row has originInstanceId`; `merged row gets suppliedByInstanceId and keeps incoming originInstanceId`; `rowOwnerCandidates orders and dedupes; returns [] when nothing known`.
- [ ] **Step 2–4:** run → FAIL, implement (`mediaRowOwners.js` + export from `server/lib/index.js` + README row), run → PASS.

---

### Task 4: Realtime event channel

**Files:**
- Create: `server/lib/peerSyncEventSchema.js`, `server/services/peerSyncEvents.js`, tests beside each
- Modify: `server/services/socket.js` (allowlist + subscribe handler), `server/services/peerSocketRelay.js`

**Interfaces:**
- `peerSyncEventSchema` (Zod, strict): `{ v: 1, category: 'videoHistory'|'imageHistory', op: 'upsert'|'delete', id: string, record?: object, tombstone?: Tombstone, originInstanceId: string }`, record size capped (builder picks, ≤64 KB).
- `emitPeerSyncEvent(event): void` broadcasts `peer:sync:event` to the Socket.IO room `peer-sync`; never throws.
- `socket.js`: add `peer:sync:subscribe`/`peer:sync:unsubscribe` to `PEER_RELAY_ALLOWED_EVENTS` (join/leave room `peer-sync`). Nothing else widens.
- `applyPeerSyncEvent(peer: { id, instanceId }, raw: unknown): Promise<void>` in `peerSyncEvents.js`: validate; for `upsert` call the shared video merge (extract `mergeVideoRows(incoming, source)` from `applyVideoHistoryRemote` so there is one implementation); for `delete` accept only if `peer.instanceId` is in `rowOwnerCandidates(row)` (or the row is unknown locally, in which case just record the tombstone), then `mergeMediaTombstones` + delete locally.
- Relay: on `connect` emit `peer:sync:subscribe`; `onPeerAgentEvent('peer:sync:event', …)` calls `applyPeerSyncEvent`, errors contained per event.
- Emit points: video generation completion and `deleteHistoryItem` (owner path), after commit. A client-visible socket event `media:history:changed` is broadcast locally so open history views refresh.

- [ ] **Step 1: Write failing tests**: schema rejects unknown category/oversize; `peer relay socket may subscribe but any other event still disconnects`; `upsert event adds a row through the shared merge`; `delete event from origin removes row`; `delete event from a non-owner peer is ignored`; `malformed frame does not throw`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS. Existing `peerSocketRelayAuth.test.js` and socket auth tests must still pass.

---

### Task 5: `media.delete` capability

**Files:**
- Modify: `server/services/instances.js` (peer record field `mediaDeleteAllowed`, default `true`, settable via the existing peer update path next to `mediaSyncMode`, ~line 615), peer settings UI (find with `rg -n "mediaSyncMode" client/src`)
- Create: `scripts/migrations/<next free number>-peer-media-delete-capability.js`
- Test: `server/services/instances.mediaDelete.test.js`, migration test beside the sibling migration tests

**Interfaces:**
- Produces: `peerMayDeleteMedia(peer): boolean` (true unless explicitly `false`) exported from `instances.js`; migration sets `mediaDeleteAllowed: true` on every existing peer lacking it and is idempotent; UI toggle labelled for the peer, persisted through the existing PATCH.

- [ ] **Step 1: Failing tests**: `new peers default to allowed`; `explicit false refuses`; `migration sets true only where absent and is re-runnable`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS. Follow `server/AGENTS.md` schema parity when adding the field.

---

### Task 6: Remote delete command, pending state, offline queue

**Files:**
- Create: `server/routes/peerMedia.js` (+ mount in the routes index, + `server/lib/validation.js` schema), `server/services/mediaRemoteDelete.js`, tests
- Modify: video delete route `server/routes/videoGen.js` (`DELETE /history/:id`), history list response, Media History client (pending badge)

**Interfaces:**
- `POST /api/peer-media/delete` body `{ kind: 'video'|'image', key: string }`, peer-credential authenticated; 403 `MEDIA_DELETE_FORBIDDEN` unless `peerMayDeleteMedia(senderPeer)`; 404 if the row is not owned/held here; success runs `deleteHistoryItem`/`deleteImage`, emits the tombstone event, returns `{ ok: true }`. Add the path to whatever peer-auth path policy applies (`server/lib/apiAccessPolicy.js` / `authGate.js`); do NOT make it always-public.
- `deleteMediaAnywhere(kind, key): Promise<{ status: 'deleted'|'pending'|'owner-unknown' }>` in `mediaRemoteDelete.js`: if this machine owns the row (origin is local, or no remote candidates and file is local) → local delete + tombstone + event. Else sends the command to the first reachable candidate from `rowOwnerCandidates`; on success applies the tombstone locally; on unreachable, persists to `data/media-delete-queue.json` (`{ peerId, kind, key, queuedAt }`), marks the row `pendingDelete` (local-only, stripped from snapshots), returns `'pending'`; on 403 un-hides and throws; with no candidates returns `'owner-unknown'` and hides locally only.
- Queue drained on `peer:online`; entries dropped after 30 days, on unpair, or if the row is re-created; cancel via `cancelPendingDelete(kind, key)`.
- Video DELETE route calls `deleteMediaAnywhere` and returns its status; the UI shows "delete pending on <peer>" with cancel, and an "owner unknown" notice.

- [ ] **Step 1: Failing tests**: `peer with capability off gets 403 and nothing is deleted`; `authorized peer delete trashes files and emits a tombstone`; `delete of a row owned by an online peer sends the command and records the tombstone only after success`; `unreachable owner queues, marks pending, and does not emit a tombstone`; `queue drains on peer:online`; `owner-unknown hides locally and sends nothing`; `403 from owner un-hides and surfaces the error`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS. Include a client test for the pending badge using scoped queries.

---

### Task 7: Image history parity

**Files:**
- Modify/Create: determined by Step 1

- [ ] **Step 1: Investigate** how deleted images are handled by the library manifest / asset-pull path (`server/routes/peerSync.js` `/library-manifest`, `server/services/peerSync.js`). Record the finding in the PR description. Write a failing test reproducing "deleted image on A reappears on B".
- [ ] **Step 2:** Implement the same mechanism keyed by filename: `deleteImage` records `recordMediaTombstone('image', filename)` and emits the `imageHistory` delete event; the manifest/pull path carries tombstones and skips tombstoned filenames; `applyPeerSyncEvent` handles `imageHistory`.
- [ ] **Step 3:** Run the new test and the existing peerSync tests → PASS. If the investigation shows this exceeds a single PR, split into its own PR within Project 1 and file the tracked follow-up per AGENTS.md.

---

### Task 8: Safety-net cadence and end-to-end proof

**Files:**
- Modify: `server/services/syncOrchestrator.js` (per-category interval for `videoHistory`/`imageHistory`), `docs/` note in the sync docs
- Test: `server/services/mediaPeerDelete.e2e.test.js`

**Interfaces:**
- Produces: `SAFETY_NET_INTERVAL_MS` (recommend 5 min) used for the migrated categories; the 60s tick remains for others; `peer:online` immediate sync unchanged.

- [ ] **Step 1: Failing e2e** with two in-process instances over real Socket.IO on loopback: `delete on A removes the row on B within the event path without a snapshot`; `B offline during delete converges on reconnect via snapshot`; `delete on B of an A-owned video removes files on A and the row on both`; `capability off on A refuses B's delete`.
- [ ] **Step 2–4:** run → FAIL, implement cadence change, run → PASS; then `npm run pregate` and a manual check against two real peers.

---

## Self-review notes

- Spec coverage: event channel (T4), safety net (T8), tombstones (T1–2), origin/supplier (T3), capability + migration (T5), remote delete + queue + pending + owner-unknown (T6), image parity (T7). Projects 2–3 explicitly excluded.
- Type consistency: `Tombstone`, `rowOwnerCandidates`, `peerMayDeleteMedia`, `deleteMediaAnywhere` names used identically across tasks.
- Known uncertainty: Task 7's shape depends on the investigation; Task 3 locates row creation sites by search.
