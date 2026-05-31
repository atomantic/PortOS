# Unreleased Changes

## Added

## Changed

- **[media-collections-per-record-store] Media collections now persist per-record instead of in one monolithic file.** `data/media-collections.json` is split into `data/media-collections/<id>/index.json` (plus a type-level `index.json` stamping the storage `schemaVersion`) via the shared `createCollectionStore` layout — the same per-record shape universes / series / issues already use. Every collection write (`addItem`, `bulkUpdateCollectionItems`, merges, tombstone GC) now serializes on its own record queue, so high-frequency render-filing no longer rewrites the whole ~200 KB document per image or blocks unrelated collections' writes. Migration `059-split-media-collections.js` performs the one-time split (idempotent, backs the legacy file up as `.bak-059`), the boot-time verifier checks the on-disk version, and the dataSync snapshot watcher tracks the directory so per-record edits still invalidate the checksum cache. The wire sync payload is unchanged, so collections still sync across peers of mixed versions.
- **[chrome-canary-followups] Custom Chrome setup writes browser config through the shared atomic writer.** The Canary setup script now uses `server/lib/fileUtils.js#atomicWrite` for browser-config updates, so it gets the same temp-file/rename behavior and Windows fallback as the rest of PortOS config persistence.
- **[media-job-store-progress-on-job-record] Render queue rows now hydrate live progress from the job record.** The media job queue now stores `progress` and `statusMsg` on the running job whenever image/video runners emit progress or status events, exposes those fields through `GET /api/media-jobs/:id` and list responses, and preserves them in persisted queue snapshots. The Image / Video render queue uses that snapshot to show a compact progress bar during polling, so non-SSE consumers no longer reset in-flight jobs to 0% until the next live event arrives.
- **[shared-bounded-concurrency-mapper] Bounded-concurrency worker pool extracted to a shared helper.** The cursor-based worker-pool idiom that was hand-rolled in `embeddings.js`, `catalogExtraction.js`, and `routes/imageVideoModels.js` is now a single tested `server/lib/mapWithConcurrency.js` (order-preserving, concurrency-bounded), with all three call sites migrated and behavior unchanged.
- Bumped the bundled slashdo submodule (`lib/slashdo`) to latest `main` (`11cb89c`).

## Fixed

- **[ltx2-fflf-skips-last-image-resize-when-both-frames-set] ltx2 FFLF now resizes both anchor frames.** The two-keyframe ltx2 FFLF path passes both `--image` and `--last-image` into `scripts/generate_ltx2.py`, but Video Gen only resized the start image when both anchors were present. The end frame could therefore reach `KeyframeInterpolationPipeline.generate_and_save()` at its original dimensions. `videoGen/local.js` now treats ltx2 true-FFLF as a real last-image consumer and runs the same ffmpeg resize/crop pass used for multi-keyframes, with a regression test asserting the helper receives resized start and end paths.

## Removed
