# Media-library federation (#1566)

**Approved:** 2026-06-24 · **Issue:** #1566 (child of #1561 full-sync tracking) · **Branch:** `next/issue-1566`

## Goal

For a declared **full-sync** peer pair, mirror the *standalone* media library — generated
images/videos/thumbnails/audio plus user-uploaded music — and their bytes, so each peer's
Media tab is a complete replica. Today only assets *referenced by a synced creative record*
get receiver-pulled; the standalone library + its bytes do not federate.

## Key finding — most of the machinery already exists

- **Byte transport** is fully reusable: static mounts for `/data/{images,image-refs,videos,
  video-thumbnails,audio,music}` all exist (`server/index.js`), and `fetchCappedAssetBuffer`
  + the receiver-pull diff are generic.
- **Video history metadata already union-merges** via the `videoHistory` dataSync category
  (union by `id`, LWW) for *all* peers — what's missing is the backing `.mp4`/thumbnail bytes.
- **`media_assets` is a derived index** rebuilt from disk by `reconcileMediaAssets()`
  (idempotent) — the receiver just re-runs it after bytes land.

So #1566 reduces to: a **library-level manifest** (vs per-record), a **fullSync-gated
receiver sweep**, two small kind-map extensions (audio + video-thumbnail), and a post-pull
reconcile.

## Decisions (locked 2026-06-24)

1. **`data/history.jsonl` is NOT federated.** It is the generic app action-audit log
   (`logAction`, 500-entry cap), machine-local activity — not media gen history. "Generation
   history converges" is satisfied by `video-history.json` (already union-merges) + image
   sidecars (ride with image bytes).
2. **All five media kinds mirror**, including user-uploaded `data/music`. `image-refs` is
   excluded (ephemeral FLUX multi-ref scratch).
3. **Byte replication is gated to `peer.fullSync === true`.** Non-fullSync peers are
   unchanged (today's record-referenced-only behavior).

## Implementation

### Sender — advertise the whole library
- `buildMediaLibraryManifest()` walks `PATHS.{images,videos,videoThumbnails,audio,music}`,
  hashes each file (reuse `hashSimpleAsset` / `getOrComputeImageSha256` / `sidecarGenParamsHash`),
  honors backup `DEFAULT_EXCLUDES`. Returns `{ schemaVersion, manifestHash, assets:
  [{ kind, filename, sha256, sidecarSha256? }] }`. Logged cap on entry count (pagination = follow-up if ever hit).
- `GET /api/peer-sync/library-manifest` in `server/routes/peerSync.js`.

### Receiver — fullSync-gated sweep
- New `server/services/sharing/mediaLibrarySync.js`: per online `fullSync` peer, fetch
  manifest (short-circuit on unchanged `manifestHash`), diff vs local disk, pull missing
  bytes via `fetchCappedAssetBuffer` (image sidecars ride alongside). Per-peer re-entrancy
  lock + cooldown. Debounced `reconcileMediaAssets()` + emit existing `peerSync:asset-arrived`.
- Hook into the existing 30s `probeAllPeers()` success path (`server/services/instances.js`).

### Shared extensions
- `assetDirForKind` (`peerSync.js:~979`) + `diffAssetManifestAgainstLocal` + per-kind byte
  caps: add `audio` → `PATHS.audio`, `video-thumbnail` → `PATHS.videoThumbnails`.
- `PORTOS_SCHEMA_VERSIONS.mediaLibrary = 1`; Zod manifest-response schema in
  `peerSyncValidation.js`; add `audio` + `video-thumbnail` to the kind enum. Receiver gently
  **skips** (not rejects) a sender whose manifest schema is newer.

### Tests
manifest build/excludes · diff across kinds (incl audio/thumbnail) · fullSync gate (non-fullSync
= no-op) · schema-skip · `history.jsonl` untouched · reconcile-after-pull called · re-entrancy lock.

## Acceptance (from #1566)
- [x] Library asset bytes replicate to full-sync peers via manifest+pull with SHA256 integrity.
- [x] Generation history union-merges across peers without duplicates (video-history + sidecars).
- [x] `media_assets` index rebuilds on the receiver after bytes arrive.
- [x] Byte replication gated to full-sync peers and respects backup exclusions.

## Test plan
Verify on this instance ↔ the `void` peer: enable fullSync A↔B, generate media on A not
attached to any synced record, confirm B's Media tab converges (and vice-versa).
