# Federated Media Sync Parity + Per-Category Sync Integrity

**Date:** 2026-05-23
**Status:** Approved design — ready for implementation plan
**Branch:** `feat/federated-media-sync-integrity`

## Problem

PortOS installs federate as peers over Tailscale. Universes and series reach
parity between nodes, but **media collections do not**, and synced images
arrive without their generation metadata. Concretely:

1. **Collections aren't first-class sync records.** `PEER_SUBSCRIBABLE_KINDS =
   ['universe', 'series']` (`server/services/sharing/peerSync.js:73`).
   Collections cross only as (a) `linkedCollection` cargo bundled when a parent
   universe/series pushes, or (b) the `mediaCollections` snapshot category —
   which is **off by default** (`DEFAULT_SYNC_CATEGORIES.mediaCollections =
   false`, `server/services/instances.js:169`). Standalone collections and
   collection edits therefore never reliably propagate.

2. **Image gen-params never travel.** The peer-sync asset manifest carries only
   `{ filename, kind, sha256 }` (`peerSync.js:458-478`) and `pullOneAsset`
   writes just the image bytes (`peerSync.js:1488`). The `.metadata.json`
   sidecar (prompt / model / seed) stays on the sender. Synced images land in
   `data/images/` with no provenance and, because the referencing collection
   didn't merge, surface in the client-side synthetic **"Unsorted"** bucket
   (`client/src/lib/unsorted.js`).

3. **The "live-pushed records" panel is opaque.** `Instances.jsx:573-634` shows
   only a record-kind label + truncated id — no name, no preview, no detail —
   so the user can't tell what they'd be unsubscribing/reversing.

4. **No manual sync.** Sync is automatic only (60s interval + `peer:online`,
   `server/services/syncOrchestrator.js`).

## Goal

Make media collections federate as reliably as universes/series, ensure synced
images carry their prompts, and give each category (Universes / Series / Media)
an at-a-glance **sync integrity badge** + deep-linkable detail drawer + manual
sync — so divergence is visible and actionable with confidence.

## Approved decisions

- **UI placement:** per-category badges on existing pages (`/universes`,
  `/pipeline`, `/media/collections`) — **no new top-level page**.
- **Collection sync fix:** make collections first-class peer-sync records
  (subscriptions + per-record push + tombstones), the same robust path
  universes/series use.
- **Scope:** all four pieces ship together (visibility + collection sync +
  sidecar metadata + manual trigger), as four logical commits.
- **Collections default:** stays **opt-in** (`mediaCollections: false` in
  `DEFAULT_SYNC_CATEGORIES`). The integrity badge surfaces a clear
  "not syncing — enable?" state rather than flipping the default.
- **Unsorted/sidecar backfill:** **both** — auto-pull sidecars going forward
  during sync, plus a manual "Pull missing prompts" repair action for images
  already sitting bare in Unsorted.

---

## Piece 1 — Media collections as first-class sync records

### Sender side
- Add `'mediaCollection'` to `PEER_SUBSCRIBABLE_KINDS` (`peerSync.js:73`).
- `buildPushPayload` (`peerSync.js:850`) gains a `sub.recordKind ===
  'mediaCollection'` branch: load the collection (`getCollection`, with an
  `includeDeleted` option), `sanitizeRecordForWire('mediaCollection', record)`,
  build its asset manifest, and (for a live record) emit a payload
  `{ kind: 'mediaCollection', record, assetManifest, sourceInstanceId,
  portosMeta }`. Tombstone push sends an empty asset manifest, matching the
  universe/series posture at `peerSync.js:865-877`.
- **Asset references for a collection.** `collectAssetReferences`
  (`server/services/sharing/exporter.js`, used at `peerSync.js:459`) expects the
  universe/series shape (`imageRefs` / `imageJobIds` / `videoPath`). Collections
  store `items: [{ kind: 'image'|'video', ref, addedAt }]`. Add
  `collectCollectionAssetReferences(collection)` that maps `image` refs →
  `PATHS.images`, `video` refs → `PATHS.videos`. Feed the existing
  `buildAssetManifest` machinery (or a thin collection wrapper).
- **recordEvents.** `mediaCollections.js` currently emits only
  `emitRecordUpdated('universe'|'series', …)` for linked parents
  (`mediaCollections.js:547-548, 605-606, 686-687, 715-716`). Add
  `emitRecordUpdated('mediaCollection', id)` on create/update/delete for the
  collection's *own* kind. Register a listener for `'mediaCollection'` in
  `peerSync.js:1626-1648`.
- **Auto-subscribe.** `createCollection` fires
  `autoSubscribeRecordToAllPeers('mediaCollection', id)`. This is gated by
  `syncCategories.mediaCollections` (default off) via the existing
  `peerHasCategory` check — opt-in is preserved automatically.

### Soft-delete / tombstones (new scope)
Collections currently **hard-delete** — `deleteCollection`
(`mediaCollections.js:534-548`) splices the record out, with no `deleted` field.
First-class sync requires tombstones, otherwise a delete can't propagate and a
reverse-subscribed peer re-pushes the record back (resurrection).

- Add `deleted: boolean` + `deletedAt: string|null` to the collection shape;
  preserve them through `sanitizeCollection` (`mediaCollections.js:86-128`).
- `deleteCollection` **marks** `deleted: true, deletedAt: now` instead of
  splicing. It still unlinks from any parent universe/series and emits the
  parent + own-kind record events.
- `listCollections` (`mediaCollections.js:131`) filters `deleted` records unless
  called with `{ includeDeleted: true }`. The synthetic Unsorted builder and all
  read paths use the filtered list.
- `mergeMediaCollectionsFromSync` (`mediaCollections.js:738`) LWW must respect
  `deleted` (a tombstone with a newer `updatedAt`/`deletedAt` wins over a live
  incumbent).
- `tombstoneGc.js` gains a `mediaCollections` sweep so acked tombstones are
  eventually pruned (parallel to universes/series/issues), keyed off
  `peerTombstoneCursors`.

### Receiver side
- The push receiver routes an incoming `mediaCollection` record through
  `mergeMediaCollectionsFromSync([record])` (already serialized on the
  collections write tail) + `diffAssetManifestAgainstLocal` +
  `pullMissingAssetsFromPeer` — reusing the existing apply path.

### Versioning & orchestrator
- Add `mediaCollections: 1` to `PORTOS_SCHEMA_VERSIONS`
  (`server/lib/schemaVersions.js:38`, currently commented). The push receiver's
  schema-version gate (`peerSync.js:1094-1124`) then protects older peers, and
  the sender pauses pushes to peers that don't advertise the version.
- `categoriesCoveredByPeerSync` (`syncOrchestrator.js:356`) maps a
  `mediaCollection` subscription → skip the `mediaCollections` snapshot category
  for that peer (now push-driven), exactly like universe→universe and
  series→pipeline.

---

## Piece 2 — Image gen-params (sidecar) sync

- `pullOneAsset` / `doPullOneAsset` (`peerSync.js:1404-1495`): after writing an
  `image`, also pull its sidecar — `imageSidecarName(filename)`
  (`server/services/sharing/buckets.js:107` → `foo.png` → `foo.metadata.json`)
  — from the peer's `/data/images/` static mount (which serves the whole
  directory, `server/index.js:540`) and `atomicWrite` it into `PATHS.images`
  alongside the image. Best-effort — a missing sidecar (404) is normal for
  assets that never had gen-params. Apply the same `sanitizeAssetFilename`
  posture to the sidecar name before any FS/network op.
- Asset manifest `image` entries carry an optional `sidecarSha256` (when a
  sidecar exists on the sender) so a *metadata-only* edit re-pulls. The
  `diffAssetManifestAgainstLocal` comparison treats a present-but-mismatched (or
  absent-locally) sidecar as a reason to re-pull.
- **Auto-backfill:** when an image is pulled (or detected sidecar-less) during a
  sync cycle, automatically attempt the sidecar pull from the source peer.
- **Manual backfill:** a "Pull missing prompts" action (see Piece 4) repairs
  images already sitting bare in Unsorted by fetching sidecars from whichever
  online peer has them.

---

## Piece 3 — Per-category sync integrity (badges + detail drawer)

### Peer-facing manifest endpoint (Tailnet-only)
`GET /api/peer-sync/manifest?kind=<universe|series|mediaCollection>` returns a
lightweight `{ id, name, updatedAt, deleted, assetHashes }[]`. Same trust
posture as the existing peer-sync routes (Tailnet-only per the documented
security model). Older peers 404 → the client renders "integrity unavailable
(peer too old)".

### Integrity API
`GET /api/peer-sync/integrity?peerId=&kind=` fetches the peer manifest, diffs it
against the local manifest, and returns per-record status:

| status | meaning |
| --- | --- |
| `in-parity` | same id, matching `updatedAt` + asset hashes |
| `local-only` | exists here, not on peer (and not a peer tombstone) |
| `peer-only` | exists on peer, not here |
| `diverged` | record fields differ (`updatedAt` mismatch) |
| `assets-missing` | record matches but one or more asset bytes absent on one side |
| `metadata-missing` | image present but sidecar (prompt) absent |

The diff is a **pure, unit-tested function** (`computeRecordIntegrity(local,
remote)`), separate from the I/O that fetches the manifests.

### Client
- A `SyncBadge` component on rows in `/universes`, `/pipeline`,
  `/media/collections` showing the worst-case status for that record across
  enabled peers, plus a distinct "not syncing — enable?" state when the category
  is opt-in-off for a peer.
- Clicking opens a **deep-linkable** detail drawer (`/media/collections/:id/sync`,
  `/universes/:id/sync`, `/pipeline/:id/sync`, per the linkable-routes rule)
  showing thumbnails/previews, the field/asset diff, and the Piece-4 actions.
- Reads from already-fetched list/dashboard state where possible (no duplicate
  fetch), per the reactive-UI conventions. Reuses existing thumbnail components.

---

## Piece 4 — Manual sync trigger

- `POST /api/peer-sync/sync-record { peerId, recordKind, recordId }` — forces
  `pushRecordToPeer` bypassing the `lastPushedHash` unchanged short-circuit
  (`peerSync.js:666`).
- `POST /api/peer-sync/sync-now { peerId }` — backfill-subscribe + push all
  records of the peer's enabled kinds (initial parity restore;
  `autoSubscribePeerToAllRecords` already exists for the subscribe half).
- `POST /api/peer-sync/pull-metadata { peerId?, filenames? }` — fetch sidecars
  for bare local images from online peers (the manual Unsorted repair).
- Buttons wired into the badge drawer: "Sync to peers", "Pull metadata",
  "Re-pull from peer".

---

## Backward / forward compatibility (distribution model)

- New push `kind: 'mediaCollection'` → the push Zod schema gains the kind; the
  schema-version gate stops us pushing it to peers that don't advertise a
  `mediaCollections` version, so no 400 storms on mixed-version federations.
- `deleted` / `deletedAt` / `sidecarSha256` are additive; older peers ignore
  unknown fields. **No on-disk migration is required** for the soft-delete field
  — absence of `deleted` reads as "live". (If runtime testing reveals existing
  collections need normalization, add a `scripts/migrations/NNN-…js`; not
  expected.)
- Integrity + manifest endpoints are new; they degrade gracefully (404 → "peer
  too old") so they never break an older peer.

## Validation & module conventions

- All new routes validated via Zod in `server/lib/validation.js`; the peer-sync
  push schema updated to accept `mediaCollection` (POST + any PUT use
  `.partial()` per the schema-parity rule).
- **No new page** → no `NAV_COMMANDS` change. Badges live on existing,
  already-registered pages; the sync detail drawer is a sub-route.
- Any new pure helper added to `server/lib/` / `client/src/lib/` / hooks /
  services gets a barrel re-export + README row per the catalog rule.

## Testing

- **Unit:** `computeRecordIntegrity` diff; collection soft-delete +
  LWW-with-`deleted` merge; `collectCollectionAssetReferences`; sidecar pull +
  backfill; `mediaCollections` tombstone GC.
- **peerSync.test.js / mediaCollections.test.js** additions for the new kind.
- Record-creating suites mock `mockNoPeers()` **and** `mockNoPeerSync()` per the
  test rule (`server/lib/mockPathsDataRoot.js`).

## Logical commit boundaries

1. Collections as first-class sync records (push/receive/subscribe/tombstone +
   schemaVersion + orchestrator skip).
2. Sidecar metadata sync (manifest field + auto-pull + backfill endpoint).
3. Integrity API + peer manifest endpoint + pure diff (server).
4. SyncBadge + detail drawer + manual-sync buttons (client).
