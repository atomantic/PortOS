/**
 * Share Bucket — exporter.
 *
 * Gathers a pipeline series / universe / media item from local state, copies
 * the referenced asset blobs (image/video files + per-asset media-job records
 * for full-fidelity re-render metadata) into the bucket, then writes a manifest
 * pointing at the bundled records.
 *
 * Asset blobs are content-addressed by SHA-256 and stored at
 * `<bucket>/assets/blobs/<hash>` (sidecar metadata at `<hash>.metadata.json`).
 * Two manifests that reference identical content under different filenames
 * share one blob on disk — the recipient maps the manifest's per-entry
 * filename back to the local `data/{kind}/<filename>` location. The asset ref
 * carries `{ kind, ref, hash }`; legacy v1 manifests without `hash` still
 * import via the `assets/{kind}/<filename>` fallback path.
 */

import { join, basename } from 'path';
import { copyFile, readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { PATHS, ensureDir, atomicWrite, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { getOrComputeImageSha256 } from '../../lib/assetHash.js';
import { isPlainObject } from '../../lib/objects.js';
import { getBucket, ensureBucketLayout, bucketBlobsDir, bucketBlobPath, bucketBlobSidecarPath, bucketBlobIndexPath, bucketRecordsDir, bucketRecordPath, imageSidecarName, isHexHash } from './buckets.js';
import { buildManifest, writeManifest, pruneBucketManifests } from './manifest.js';
import { listSeries, getSeries } from '../pipeline/series.js';
import { listIssues } from '../pipeline/issues.js';
import { getReview } from '../pipeline/manuscriptReview.js';
import { getUniverse } from '../universeBuilder.js';
import { findCollectionByUniverseId, findCollectionBySeriesId } from '../mediaCollections.js';
import { getJob } from '../mediaJobQueue/index.js';
import { getInstanceId } from '../instances.js';
import { getSettings } from '../settings.js';
import { getProducedByVersion } from './version.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { isStr, listSheetPointers } from '../../lib/storyBible.js';
import { resolveBucketSourceName as resolveSourceName } from './annotationIdentity.js';

/**
 * Best-effort cap on the bucket's manifest directory after each export.
 * Subscription manifests + peer-authored manifests are exempt — see
 * `pruneBucketManifests` for the policy. Failures are logged + swallowed
 * so the export response isn't blocked on an archive miss.
 */
async function pruneAfterExport(bucket, senderInstanceId) {
  await pruneBucketManifests(bucket, { localInstanceId: senderInstanceId }).catch((err) => {
    console.log(`⚠️ sharing.exporter: pruneBucketManifests failed for bucket=${bucket.name}: ${err.message}`);
  });
}

async function resolveSourceBio(bucket) {
  if (bucket.bioOverride) return bucket.bioOverride;
  const settings = await getSettings().catch(() => ({}));
  if (isStr(settings?.sharingBio) && settings.sharingBio.trim()) {
    return settings.sharingBio.trim();
  }
  return null;
}

/**
 * Copy `<sourceDir>/<filename>` into the bucket's content-addressed blob store.
 * Returns `{ kind, ref, hash }`; the recipient maps `ref` (the original
 * filename) back to its `data/{kind}/<ref>` slot. Two manifests that ship
 * identical bytes under different filenames share one blob.
 *
 * First-writer wins on sidecar collision: identical bytes imply identical
 * gen params in practice, so the second writer's (possibly missing) sidecar
 * doesn't overwrite the first's.
 */
// 'image-ref' covers files under data/image-refs/ (multi-ref upload inputs
// + generated character reference sheets). No sidecar handling — these
// don't carry the gen-params metadata sidecar that gallery images do.
const ASSET_SOURCE_DIRS = Object.freeze({
  video: PATHS.videos,
  image: PATHS.images,
  'image-ref': PATHS.imageRefs,
});

/**
 * Per-bucket sidecar mapping `<sourcePath>:<mtimeMs>:<size> → <hash>` so a
 * re-export of an unchanged asset skips both `sha256File` (multi-GB stream
 * read) and the redundant `copyFile`. mtime change invalidates because it's
 * part of the key. The cache lives next to the blobs so it shares lifetime
 * with the bucket. See `[sharing-exporter-cache-sourcefile-hash-by-mtime]`.
 *
 * `withAssetHashCache` owns the load/mutate/save lifetime: it loads once,
 * runs the body, and only writes when entries were added. Pre-write, it
 * re-reads from disk and merges so a sibling exporter (e.g. `exportByKind`
 * fanning out parallel `exportSeries` against the same bucket) doesn't get
 * its accumulated entries clobbered — same-key collisions converge to the
 * same hash since the hash derives from bytes and the key embeds mtime+size.
 */
async function loadAssetHashCache(bucketPath) {
  const raw = await readJSONFile(bucketBlobIndexPath(bucketPath), {}, { logError: false });
  return isPlainObject(raw) ? raw : {};
}

// Per-bucket cache-write tail — serializes the re-load → merge → atomicWrite
// step so two concurrent exporters (e.g. `exportByKind` fanning out parallel
// `exportSeries`) accumulate entries instead of clobbering. Mirrors the
// `issueWriteTail` pattern in `pipeline/issues.js`.
const cacheWriteTails = new Map();

async function withAssetHashCache(bucketPath, fn) {
  const cache = await loadAssetHashCache(bucketPath);
  const initialKeys = Object.keys(cache).length;
  const result = await fn(cache);
  if (Object.keys(cache).length !== initialKeys) {
    const prevTail = cacheWriteTails.get(bucketPath) || Promise.resolve();
    const tail = prevTail.then(async () => {
      const onDisk = await loadAssetHashCache(bucketPath);
      await atomicWrite(bucketBlobIndexPath(bucketPath), { ...onDisk, ...cache });
    });
    cacheWriteTails.set(bucketPath, tail);
    await tail;
  }
  return result;
}

async function copyAssetIfPresent(filename, kind, bucketPath, cache) {
  if (!filename || typeof filename !== 'string') return null;
  const base = basename(filename);
  if (!base || base !== filename) return null; // refuse path traversal
  const sourceDir = ASSET_SOURCE_DIRS[kind] || PATHS.images;
  await ensureDir(bucketBlobsDir(bucketPath));
  const sourcePath = join(sourceDir, base);
  const info = await stat(sourcePath).catch(() => null);
  if (!info) {
    console.log(`⚠️ sharing.exporter: asset not found locally, skipping: ${sourcePath}`);
    return null;
  }
  const cacheKey = `${sourcePath}:${info.mtimeMs}:${info.size}`;
  let hash = cache && isHexHash(cache[cacheKey]) ? cache[cacheKey] : null;
  if (!hash || !existsSync(bucketBlobPath(bucketPath, hash))) {
    // For images, prefer the cross-transport sidecar cache (lib/assetHash) —
    // it persists the hash next to the asset so the peer-sync push pipeline
    // (which has no bucket context) can read the same value. The bucket
    // cache is still populated so future exports inside this bucket take
    // the fast path. For non-image kinds (videos), no sidecar exists yet so
    // fall through to direct sha256File.
    if (kind === 'image') {
      const sidecarResult = await getOrComputeImageSha256(sourcePath);
      hash = sidecarResult?.hash || (await sha256File(sourcePath));
    } else {
      hash = await sha256File(sourcePath);
    }
    if (cache) cache[cacheKey] = hash;
  }
  const blobPath = bucketBlobPath(bucketPath, hash);
  if (!existsSync(blobPath)) await copyFile(sourcePath, blobPath);
  if (kind === 'image') {
    const sidecarSource = join(sourceDir, imageSidecarName(base));
    if (existsSync(sidecarSource)) {
      const sidecarTarget = bucketBlobSidecarPath(bucketPath, hash);
      if (!existsSync(sidecarTarget)) await copyFile(sidecarSource, sidecarTarget);
    }
  }
  return { kind, ref: base, hash };
}

/**
 * Build a synthetic job record from a `.metadata.json` sidecar when the
 * in-memory queue/archive no longer holds the job (>24h TTL). The sidecar
 * lives alongside the image file so its lifetime is tied to the asset.
 *
 * Guards against path traversal: rejects any jobId that contains a path
 * separator, parent-directory token, or otherwise normalizes to something
 * other than its bare basename. A corrupted or hostile imageJobId
 * (`../../etc/passwd`, `..\foo`, absolute paths) could otherwise read
 * arbitrary JSON outside `PATHS.images`. Same posture as `copyAssetIfPresent`.
 */
async function jobFromSidecar(jobId) {
  if (typeof jobId !== 'string' || !jobId) return null;
  if (basename(jobId) !== jobId) return null;
  if (jobId.includes('/') || jobId.includes('\\') || jobId.includes('..')) return null;
  const sc = await readJSONFile(join(PATHS.images, `${jobId}.metadata.json`));
  if (!sc) return null;
  // Sidecar schema differs between paths:
  //   codex.js writes { mode: 'codex', model }
  //   local.js writes { modelId } and omits `mode` (it's locally-rendered)
  // Map both to a unified { mode, model } so re-render fidelity is preserved
  // for local renders too (without this, local-render shares lost both fields
  // once the in-memory job queue aged out and re-render fell back to defaults).
  return {
    id: sc.id || jobId,
    kind: 'image',
    owner: null,
    status: 'completed',
    completedAt: sc.createdAt || null,
    params: {
      prompt: sc.prompt,
      negativePrompt: sc.negativePrompt,
      width: sc.width,
      height: sc.height,
      mode: sc.mode || (sc.modelId ? 'local' : null),
      model: sc.model || sc.modelId || null,
      seed: sc.seed,
      steps: sc.steps,
      guidance: sc.guidance,
    },
    result: { filename: sc.filename },
  };
}

/**
 * For each `imageJobId`, fetch the live media-job (or look it up in the persisted
 * archive) and write a sanitized copy into the bucket records/media/ so the
 * recipient can re-render with identical prompt/seed/params. Falls back to the
 * per-image `.metadata.json` sidecar for jobs older than the 24h archive TTL.
 * Returns the asset refs (image filenames) discovered.
 */
async function exportMediaJobAndAsset(jobId, bucketPath, cache) {
  if (!jobId || !isStr(jobId)) return [];
  const job = getJob(jobId) || await jobFromSidecar(jobId);
  if (!job) {
    console.log(`⚠️ sharing.exporter: imageJobId ${jobId} not found in live queue, archive, or sidecar`);
    return [];
  }
  // Trim transient/runtime fields — keep enough to re-render with full fidelity.
  const exported = {
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    status: job.status,
    completedAt: job.completedAt,
    params: job.params,
    result: job.result,
  };
  await ensureDir(bucketRecordsDir(bucketPath, 'media'));
  await atomicWrite(bucketRecordPath(bucketPath, 'media', job.id), exported);
  // Copy the produced asset(s).
  const assetKind = job.kind === 'video' ? 'video' : 'image';
  const refs = [];
  // result.filename is the canonical single-output shape; some video paths use
  // result.videoPath / result.thumbnail; handle both defensively.
  if (job.result?.filename) {
    const ref = await copyAssetIfPresent(job.result.filename, assetKind, bucketPath, cache);
    if (ref) refs.push(ref);
  }
  if (job.result?.videoPath) {
    // videoPath is a filesystem path; we only need its basename here since
    // copyAssetIfPresent rebuilds the source dir.
    const ref = await copyAssetIfPresent(basename(job.result.videoPath), 'video', bucketPath, cache);
    if (ref) refs.push(ref);
  }
  if (Array.isArray(job.result?.images)) {
    for (const im of job.result.images) {
      const fname = im?.filename || im?.path;
      if (!fname) continue;
      const ref = await copyAssetIfPresent(basename(fname), assetKind, bucketPath, cache);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/**
 * Walk a record and collect every (imageJobId, imageRefs, videoPath, sceneVideoJobId)
 * it references. Used by the series exporter to enumerate what to copy. The
 * caller decides whether to fetch + write the media-job records.
 *
 * Exported so the peer-sync push pipeline (services/sharing/peerSync.js) can
 * build its asset manifest from the same field-walk used for share-bucket
 * exports — both transports MUST agree on what counts as "an asset of this
 * record" so a missing-assets diff matches what the sender actually owns.
 */
export function collectAssetReferences(record) {
  const jobIds = new Set();
  const directImageFilenames = new Set();
  const directVideoFilenames = new Set();
  // Character reference sheets — files live under data/image-refs/, distinct
  // from the gallery (data/images/). Tracked separately so the export loop
  // can route them through the 'image-ref' source-dir branch.
  const directImageRefFilenames = new Set();

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    // Known shape carriers
    if (isStr(node.imageJobId)) jobIds.add(node.imageJobId);
    if (isStr(node.sceneVideoJobId)) jobIds.add(node.sceneVideoJobId);
    if (Array.isArray(node.imageRefs)) {
      for (const r of node.imageRefs) if (isStr(r)) directImageFilenames.add(r);
    }
    // Every character-sheet variant the renderer produced — legacy + map.
    // listSheetPointers yields one entry per non-empty pointer regardless of
    // storage shape, so the export bundle includes every render.
    for (const { filename } of listSheetPointers(node)) {
      if (isStr(filename)) directImageRefFilenames.add(filename);
    }
    if (isStr(node.videoPath)) directVideoFilenames.add(basename(node.videoPath));
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && (Array.isArray(v) || typeof v === 'object')) walk(v);
    }
  };
  walk(record);

  return {
    jobIds: [...jobIds],
    directImageFilenames: [...directImageFilenames],
    directVideoFilenames: [...directVideoFilenames],
    directImageRefFilenames: [...directImageRefFilenames],
  };
}


/**
 * Walk a collection's items and return:
 *   - assetFilenames: every {kind, ref} pair to copy into the bucket
 *   - jobIds: every media-job record the items resolve to (for re-render
 *     metadata fidelity on the recipient side — same logic as imageJobId
 *     resolution on canon entries)
 *
 * The serialized `collection` payload in the manifest carries the raw
 * items + the linked owner id (universeId OR seriesId) + the canonical
 * name; the recipient's importer reuses these to find-or-create a local
 * collection of the same name and add the items.
 */
function collectCollectionAssets(collection) {
  const assetFilenames = [];
  const jobIds = new Set();
  if (!collection) return { assetFilenames, jobIds: [] };
  for (const it of collection.items || []) {
    if (!it?.ref || typeof it.ref !== 'string') continue;
    assetFilenames.push({ kind: it.kind, ref: it.ref });
    // Strip extension to recover the media-job id (matches the convention
    // used in exportMedia's lookup path: filenames are `<jobId>.<ext>`).
    const baseId = it.ref.replace(/\.[a-z0-9]+$/i, '');
    if (baseId && baseId !== it.ref) jobIds.add(baseId);
  }
  return { assetFilenames, jobIds: [...jobIds] };
}

/** Stamp the outgoing record with origin metadata. */
function stampOrigin(record, { bucket, source, sourceBio, manifestId }) {
  return {
    ...record,
    origin: {
      bucketId: bucket.id,
      bucketName: bucket.name,
      source,
      sourceBio,
      manifestId,
      importedAt: new Date().toISOString(),
    },
  };
}

/**
 * Export a full series (with its issues + linked universe + every asset).
 *
 * `opts.subscription` (optional): when set to `{ recordKind, recordId }` the
 * manifest is marked as a subscription — bucket-side filename becomes
 * deterministic (`sub-series-<id>-<senderInstanceId>.json`) so re-exports
 * overwrite in place instead of accumulating, and two peers sharing the same
 * series don't collide on the bucket file. Omit for one-shot legacy shares.
 */
export async function exportSeries(seriesId, bucketId, opts = {}) {
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const series = await getSeries(seriesId);
  const issues = await listIssues({ seriesId });
  let universe = null;
  let linkedCollection = null;
  if (series.universeId) {
    universe = await getUniverse(series.universeId).catch(() => null);
    if (universe) linkedCollection = await findCollectionByUniverseId(universe.id);
  }
  // Per-series fallback so a universeless series still ships with its
  // auto-filed cover renders via the seriesId-stamped collection. Gate on
  // `series.universeId` being absent — a series that has been linked to a
  // universe must always export under the universe-collection contract,
  // even if a stale seriesId-stamped collection survives from before the
  // link (orphaned mid-flight by `unlinkCollectionsForUniverse` recovery, or
  // a legacy bucket from an earlier universeless state).
  if (!linkedCollection && !series.universeId) {
    linkedCollection = await findCollectionBySeriesId(series.id);
  }

  const [source, sourceBio, senderInstanceId, producedByVersion] = await Promise.all([
    resolveSourceName(bucket),
    resolveSourceBio(bucket),
    getInstanceId().catch(() => null),
    getProducedByVersion(),
  ]);

  // Pre-build manifest id so we can stamp it onto every record's origin.
  const manifestStub = buildManifest({
    kind: 'series',
    senderInstanceId,
    source, sourceBio,
    producedByVersion,
    portosSchemaVersions: PORTOS_SCHEMA_VERSIONS,
    subscription: opts.subscription || null,
    collection: linkedCollection,
    bucketId: bucket.id,
    bucketName: bucket.name,
    recordIds: [],
    assetRefs: [],
  });
  const manifestId = manifestStub.id;

  // Write records.
  const recordIds = [series.id];
  const stampedSeries = stampOrigin(series, { bucket, source, sourceBio, manifestId });
  await atomicWrite(bucketRecordPath(bucket.path, 'series', series.id), stampedSeries);

  // Bundle the manuscript-review sibling doc (the "Finish the draft" comment
  // set) so it travels with the series. It's keyed by seriesId — not a record
  // id of its own — so it lives under records/reviews/ and is NOT added to
  // `recordIds` (the importer reads it by seriesId after the series merges).
  // Skip when empty so we don't litter the bucket with no-op review files; an
  // importer that finds no file simply leaves the local review untouched.
  const review = await getReview(series.id).catch(() => null);
  const reviewRefs = [];
  if (review && Array.isArray(review.comments) && review.comments.length > 0) {
    await atomicWrite(bucketRecordPath(bucket.path, 'reviews', series.id), review);
    reviewRefs.push(series.id);
  }

  for (const issue of issues) {
    recordIds.push(issue.id);
    const stamped = stampOrigin(issue, { bucket, source, sourceBio, manifestId });
    await atomicWrite(bucketRecordPath(bucket.path, 'issues', issue.id), stamped);
  }

  if (universe) {
    recordIds.push(universe.id);
    const stampedUni = stampOrigin(universe, { bucket, source, sourceBio, manifestId });
    await atomicWrite(bucketRecordPath(bucket.path, 'universes', universe.id), stampedUni);
  }

  // Gather asset refs across every record, plus the universe's linked
  // collection items (if any) so universe-render output ships alongside
  // the series.
  const allJobIds = new Set();
  const allImageFiles = new Set();
  const allVideoFiles = new Set();
  const allImageRefFiles = new Set();
  for (const rec of [series, ...issues, universe].filter(Boolean)) {
    const refs = collectAssetReferences(rec);
    refs.jobIds.forEach((j) => allJobIds.add(j));
    refs.directImageFilenames.forEach((f) => allImageFiles.add(f));
    refs.directVideoFilenames.forEach((f) => allVideoFiles.add(f));
    refs.directImageRefFilenames.forEach((f) => allImageRefFiles.add(f));
  }
  if (linkedCollection) {
    const collAssets = collectCollectionAssets(linkedCollection);
    collAssets.jobIds.forEach((j) => allJobIds.add(j));
    for (const a of collAssets.assetFilenames) {
      if (a.kind === 'video') allVideoFiles.add(a.ref); else allImageFiles.add(a.ref);
    }
  }

  // Copy media-job records + their assets — run all four groups in parallel.
  const assetRefs = await withAssetHashCache(bucket.path, async (cache) => {
    const [jobRefGroups, imageRefs, videoRefs, imageRefRefs] = await Promise.all([
      Promise.all([...allJobIds].map((jobId) => exportMediaJobAndAsset(jobId, bucket.path, cache))),
      Promise.all([...allImageFiles].map((f) => copyAssetIfPresent(f, 'image', bucket.path, cache))),
      Promise.all([...allVideoFiles].map((f) => copyAssetIfPresent(f, 'video', bucket.path, cache))),
      Promise.all([...allImageRefFiles].map((f) => copyAssetIfPresent(f, 'image-ref', bucket.path, cache))),
    ]);
    return [...jobRefGroups.flat(), ...imageRefs.filter(Boolean), ...videoRefs.filter(Boolean), ...imageRefRefs.filter(Boolean)];
  });

  const manifest = { ...manifestStub, recordIds, assetRefs, reviewRefs };
  const filename = await writeManifest(bucket.path, manifest);
  await pruneAfterExport(bucket, senderInstanceId);
  return { manifestId, filename, recordCount: recordIds.length, assetCount: assetRefs.length };
}

/** Export a universe on its own (no series attached). See exportSeries for opts. */
export async function exportUniverse(universeId, bucketId, opts = {}) {
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const universe = await getUniverse(universeId);
  const linkedCollection = await findCollectionByUniverseId(universe.id);

  const [source, sourceBio, senderInstanceId, producedByVersion] = await Promise.all([
    resolveSourceName(bucket),
    resolveSourceBio(bucket),
    getInstanceId().catch(() => null),
    getProducedByVersion(),
  ]);

  const manifestStub = buildManifest({
    kind: 'universe',
    senderInstanceId,
    source, sourceBio,
    producedByVersion,
    portosSchemaVersions: PORTOS_SCHEMA_VERSIONS,
    subscription: opts.subscription || null,
    collection: linkedCollection,
    bucketId: bucket.id,
    bucketName: bucket.name,
    recordIds: [],
    assetRefs: [],
  });
  const manifestId = manifestStub.id;

  const stamped = stampOrigin(universe, { bucket, source, sourceBio, manifestId });
  await atomicWrite(bucketRecordPath(bucket.path, 'universes', universe.id), stamped);

  // Combine universe-record asset refs with the linked collection's assets
  // so a single export pass pulls everything the universe needs.
  const universeRefs = collectAssetReferences(universe);
  const collectionAssets = collectCollectionAssets(linkedCollection);
  const allJobIds = new Set([...universeRefs.jobIds, ...collectionAssets.jobIds]);
  const allImageFiles = new Set([
    ...universeRefs.directImageFilenames,
    ...collectionAssets.assetFilenames.filter((a) => a.kind === 'image').map((a) => a.ref),
  ]);
  const allVideoFiles = new Set(
    collectionAssets.assetFilenames.filter((a) => a.kind === 'video').map((a) => a.ref),
  );
  const allImageRefFiles = new Set(universeRefs.directImageRefFilenames);

  const assetRefs = await withAssetHashCache(bucket.path, async (cache) => {
    const [jobRefGroups, imageRefs, videoRefs, imageRefRefs] = await Promise.all([
      Promise.all([...allJobIds].map((jobId) => exportMediaJobAndAsset(jobId, bucket.path, cache))),
      Promise.all([...allImageFiles].map((f) => copyAssetIfPresent(f, 'image', bucket.path, cache))),
      Promise.all([...allVideoFiles].map((f) => copyAssetIfPresent(f, 'video', bucket.path, cache))),
      Promise.all([...allImageRefFiles].map((f) => copyAssetIfPresent(f, 'image-ref', bucket.path, cache))),
    ]);
    return [...jobRefGroups.flat(), ...imageRefs.filter(Boolean), ...videoRefs.filter(Boolean), ...imageRefRefs.filter(Boolean)];
  });

  const manifest = { ...manifestStub, recordIds: [universe.id], assetRefs };
  const filename = await writeManifest(bucket.path, manifest);
  await pruneAfterExport(bucket, senderInstanceId);
  return { manifestId, filename, recordCount: 1, assetCount: assetRefs.length };
}

/**
 * Export individual media items (images / videos identified by `{ kind, ref }`).
 * Looks up each ref's media-job (best effort) to bundle prompt/params alongside
 * the blob. If no job is found (manually uploaded image), the blob still ships
 * but without re-render metadata — recipient sees the file with no params.
 */
export async function exportMedia(items, bucketId) {
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const [source, sourceBio, senderInstanceId, producedByVersion] = await Promise.all([
    resolveSourceName(bucket),
    resolveSourceBio(bucket),
    getInstanceId().catch(() => null),
    getProducedByVersion(),
  ]);

  const manifestStub = buildManifest({
    kind: 'media',
    senderInstanceId,
    source, sourceBio,
    producedByVersion,
    portosSchemaVersions: PORTOS_SCHEMA_VERSIONS,
    bucketId: bucket.id,
    bucketName: bucket.name,
    recordIds: [],
    assetRefs: [],
  });
  const manifestId = manifestStub.id;

  // Pre-resolve each item to a job (or null) so we know what to parallelize
  // and what record ids to collect for the manifest.
  const resolved = (items || []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const ref = isStr(item.ref) ? item.ref.trim() : '';
    if (!ref) return [];
    const kind = item.kind === 'video' ? 'video' : 'image';
    const baseId = ref.replace(/\.[a-z0-9]+$/i, '');
    return [{ ref, kind, job: getJob(baseId) }];
  });
  const recordIds = resolved.filter((r) => r.job).map((r) => r.job.id);
  const assetRefs = await withAssetHashCache(bucket.path, async (cache) => {
    const results = await Promise.all(resolved.map(async (r) => {
      if (r.job) return exportMediaJobAndAsset(r.job.id, bucket.path, cache);
      const copied = await copyAssetIfPresent(r.ref, r.kind, bucket.path, cache);
      return copied ? [copied] : [];
    }));
    return results.flat();
  });

  const manifest = { ...manifestStub, recordIds, assetRefs };
  const filename = await writeManifest(bucket.path, manifest);
  await pruneAfterExport(bucket, senderInstanceId);
  return { manifestId, filename, recordCount: recordIds.length, assetCount: assetRefs.length };
}

/** Dispatch by kind. */
export async function exportByKind({ kind, ids, items, bucketId }) {
  if (kind === 'series') {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('exportByKind: ids required for series');
    const results = await Promise.all(ids.map((id) => exportSeries(id, bucketId)));
    return { exports: results };
  }
  if (kind === 'universe') {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('exportByKind: ids required for universe');
    const results = await Promise.all(ids.map((id) => exportUniverse(id, bucketId)));
    return { exports: results };
  }
  if (kind === 'media') {
    if (!Array.isArray(items) || items.length === 0) throw new Error('exportByKind: items required for media');
    return { exports: [await exportMedia(items, bucketId)] };
  }
  throw new Error(`exportByKind: unknown kind '${kind}'`);
}
