/**
 * Share Bucket — exporter.
 *
 * Gathers a pipeline series / universe / media item from local state, copies
 * the referenced asset blobs (image/video files + per-asset media-job records
 * for full-fidelity re-render metadata) into the bucket, then writes a manifest
 * pointing at the bundled records.
 *
 * Asset filenames are already UUIDs (data/images/<uuid>.png), so collisions
 * between peers' exports are extremely unlikely. We skip-if-present rather than
 * overwrite — a re-share that includes the same asset is a no-op for the blob
 * copy, but the manifest still references it so the recipient knows the asset
 * belongs to the latest share.
 */

import { join, basename } from 'path';
import { copyFile, readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { getBucket, ensureBucketLayout } from './buckets.js';
import { buildManifest, writeManifest, pruneBucketManifests } from './manifest.js';
import { listSeries, getSeries } from '../pipeline/series.js';
import { listIssues } from '../pipeline/issues.js';
import { getUniverse } from '../universeBuilder.js';
import { listCollections } from '../mediaCollections.js';
import { getJob } from '../mediaJobQueue/index.js';
import { getInstanceId } from '../instances.js';
import { getSettings } from '../settings.js';
import { getProducedByVersion } from './version.js';
import { isStr } from '../../lib/storyBible.js';
import { resolveGlobalDisplayName } from './annotationIdentity.js';

/** Resolve the bucket-effective display name (per-bucket override → global identity). */
async function resolveSourceName(bucket) {
  if (bucket.displayNameOverride) return bucket.displayNameOverride;
  return resolveGlobalDisplayName();
}

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

/** Copy an asset file from `data/images` or `data/videos` into the bucket. Returns ref entry. */
async function copyAssetIfPresent(filename, kind, bucketPath) {
  if (!filename || typeof filename !== 'string') return null;
  const base = basename(filename);
  if (!base || base !== filename) return null; // refuse path traversal
  const sourceDir = kind === 'video' ? PATHS.videos : PATHS.images;
  const targetDir = join(bucketPath, 'assets', kind === 'video' ? 'videos' : 'images');
  await ensureDir(targetDir);
  const sourcePath = join(sourceDir, base);
  if (!existsSync(sourcePath)) {
    console.log(`⚠️ sharing.exporter: asset not found locally, skipping: ${sourcePath}`);
    return null;
  }
  const targetPath = join(targetDir, base);
  if (!existsSync(targetPath)) {
    await copyFile(sourcePath, targetPath);
  }
  // Also copy the sidecar metadata.json (image-gen path stamps prompts there).
  if (kind === 'image') {
    const sidecarBase = base.replace(/\.(png|jpe?g|webp)$/i, '') + '.metadata.json';
    const sidecarSource = join(sourceDir, sidecarBase);
    if (existsSync(sidecarSource)) {
      const sidecarTarget = join(targetDir, sidecarBase);
      if (!existsSync(sidecarTarget)) await copyFile(sidecarSource, sidecarTarget);
    }
  }
  return { kind, ref: base };
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
async function exportMediaJobAndAsset(jobId, bucketPath, mediaRecordsDir) {
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
  await ensureDir(mediaRecordsDir);
  await atomicWrite(join(mediaRecordsDir, `${job.id}.json`), exported);
  // Copy the produced asset(s).
  const assetKind = job.kind === 'video' ? 'video' : 'image';
  const refs = [];
  // result.filename is the canonical single-output shape; some video paths use
  // result.videoPath / result.thumbnail; handle both defensively.
  if (job.result?.filename) {
    const ref = await copyAssetIfPresent(job.result.filename, assetKind, bucketPath);
    if (ref) refs.push(ref);
  }
  if (job.result?.videoPath) {
    // videoPath is a filesystem path; we only need its basename here since
    // copyAssetIfPresent rebuilds the source dir.
    const ref = await copyAssetIfPresent(basename(job.result.videoPath), 'video', bucketPath);
    if (ref) refs.push(ref);
  }
  if (Array.isArray(job.result?.images)) {
    for (const im of job.result.images) {
      const fname = im?.filename || im?.path;
      if (!fname) continue;
      const ref = await copyAssetIfPresent(basename(fname), assetKind, bucketPath);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/**
 * Walk a record and collect every (imageJobId, imageRefs, videoPath, sceneVideoJobId)
 * it references. Used by the series exporter to enumerate what to copy. The
 * caller decides whether to fetch + write the media-job records.
 */
function collectAssetReferences(record) {
  const jobIds = new Set();
  const directImageFilenames = new Set();
  const directVideoFilenames = new Set();

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
  };
}

/**
 * Find the media collection linked to a universe. Prefers the explicit
 * `universeId` field on the collection (added by the universe-builder
 * route); falls back to matching the conventional `Universe: <name>`
 * name. Returns null when nothing's linked.
 */
async function findCollectionForUniverse(universe) {
  if (!universe?.id) return null;
  const all = await listCollections().catch(() => []);
  const direct = all.find((c) => c.universeId === universe.id);
  if (direct) return direct;
  const conventional = `universe: ${(universe.name || '').toLowerCase()}`;
  const legacy = all.find((c) => (c.name || '').toLowerCase() === conventional);
  // Legacy universe-builder collections were named conventionally but did not
  // carry the explicit link. Preserve the link in the share payload so the
  // importer can restore membership instead of leaving copied assets unsorted.
  return legacy ? { ...legacy, universeId: universe.id } : null;
}

/**
 * Walk a collection's items and return:
 *   - assetFilenames: every {kind, ref} pair to copy into the bucket
 *   - jobIds: every media-job record the items resolve to (for re-render
 *     metadata fidelity on the recipient side — same logic as imageJobId
 *     resolution on canon entries)
 *
 * The serialized `collection` payload in the manifest carries the raw
 * items + the linked universeId + the canonical name; the recipient's
 * importer reuses these to find-or-create a local collection of the
 * same name and add the items.
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
 * deterministic (`sub-series-<id>.json`) so re-exports overwrite in place
 * instead of accumulating. Omit for one-shot legacy shares.
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
    if (universe) linkedCollection = await findCollectionForUniverse(universe);
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
  await atomicWrite(join(bucket.path, 'records', 'series', `${series.id}.json`), stampedSeries);

  for (const issue of issues) {
    recordIds.push(issue.id);
    const stamped = stampOrigin(issue, { bucket, source, sourceBio, manifestId });
    await atomicWrite(join(bucket.path, 'records', 'issues', `${issue.id}.json`), stamped);
  }

  if (universe) {
    recordIds.push(universe.id);
    const stampedUni = stampOrigin(universe, { bucket, source, sourceBio, manifestId });
    await atomicWrite(join(bucket.path, 'records', 'universes', `${universe.id}.json`), stampedUni);
  }

  // Gather asset refs across every record, plus the universe's linked
  // collection items (if any) so universe-render output ships alongside
  // the series.
  const allJobIds = new Set();
  const allImageFiles = new Set();
  const allVideoFiles = new Set();
  for (const rec of [series, ...issues, universe].filter(Boolean)) {
    const refs = collectAssetReferences(rec);
    refs.jobIds.forEach((j) => allJobIds.add(j));
    refs.directImageFilenames.forEach((f) => allImageFiles.add(f));
    refs.directVideoFilenames.forEach((f) => allVideoFiles.add(f));
  }
  if (linkedCollection) {
    const collAssets = collectCollectionAssets(linkedCollection);
    collAssets.jobIds.forEach((j) => allJobIds.add(j));
    for (const a of collAssets.assetFilenames) {
      if (a.kind === 'video') allVideoFiles.add(a.ref); else allImageFiles.add(a.ref);
    }
  }

  // Copy media-job records + their assets — run all three groups in parallel.
  const mediaRecordsDir = join(bucket.path, 'records', 'media');
  const [jobRefGroups, imageRefs, videoRefs] = await Promise.all([
    Promise.all([...allJobIds].map((jobId) => exportMediaJobAndAsset(jobId, bucket.path, mediaRecordsDir))),
    Promise.all([...allImageFiles].map((f) => copyAssetIfPresent(f, 'image', bucket.path))),
    Promise.all([...allVideoFiles].map((f) => copyAssetIfPresent(f, 'video', bucket.path))),
  ]);
  const assetRefs = [...jobRefGroups.flat(), ...imageRefs.filter(Boolean), ...videoRefs.filter(Boolean)];

  const manifest = { ...manifestStub, recordIds, assetRefs };
  const filename = await writeManifest(bucket.path, manifest);
  await pruneAfterExport(bucket, senderInstanceId);
  return { manifestId, filename, recordCount: recordIds.length, assetCount: assetRefs.length };
}

/** Export a universe on its own (no series attached). See exportSeries for opts. */
export async function exportUniverse(universeId, bucketId, opts = {}) {
  const bucket = await getBucket(bucketId);
  await ensureBucketLayout(bucket);
  const universe = await getUniverse(universeId);
  const linkedCollection = await findCollectionForUniverse(universe);

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
    subscription: opts.subscription || null,
    collection: linkedCollection,
    bucketId: bucket.id,
    bucketName: bucket.name,
    recordIds: [],
    assetRefs: [],
  });
  const manifestId = manifestStub.id;

  const stamped = stampOrigin(universe, { bucket, source, sourceBio, manifestId });
  await atomicWrite(join(bucket.path, 'records', 'universes', `${universe.id}.json`), stamped);

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

  const mediaRecordsDir = join(bucket.path, 'records', 'media');
  const [jobRefGroups, imageRefs, videoRefs] = await Promise.all([
    Promise.all([...allJobIds].map((jobId) => exportMediaJobAndAsset(jobId, bucket.path, mediaRecordsDir))),
    Promise.all([...allImageFiles].map((f) => copyAssetIfPresent(f, 'image', bucket.path))),
    Promise.all([...allVideoFiles].map((f) => copyAssetIfPresent(f, 'video', bucket.path))),
  ]);
  const assetRefs = [...jobRefGroups.flat(), ...imageRefs.filter(Boolean), ...videoRefs.filter(Boolean)];

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
    bucketId: bucket.id,
    bucketName: bucket.name,
    recordIds: [],
    assetRefs: [],
  });
  const manifestId = manifestStub.id;

  const mediaRecordsDir = join(bucket.path, 'records', 'media');
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
  const results = await Promise.all(resolved.map(async (r) => {
    if (r.job) return exportMediaJobAndAsset(r.job.id, bucket.path, mediaRecordsDir);
    const copied = await copyAssetIfPresent(r.ref, r.kind, bucket.path);
    return copied ? [copied] : [];
  }));
  const assetRefs = results.flat();

  const manifest = { ...manifestStub, recordIds, assetRefs };
  const filename = await writeManifest(bucket.path, manifest);
  await pruneAfterExport(bucket, senderInstanceId);
  return { manifestId, filename, recordCount: recordIds.length, assetCount: assetRefs.length };
}

/** Dispatch by kind. */
export async function exportByKind({ kind, ids, items, bucketId }) {
  if (kind === 'series') {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('exportByKind: ids required for series');
    // For v1 we export one series per request; loop if multiple are passed.
    const results = [];
    for (const id of ids) results.push(await exportSeries(id, bucketId));
    return { exports: results };
  }
  if (kind === 'universe') {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('exportByKind: ids required for universe');
    const results = [];
    for (const id of ids) results.push(await exportUniverse(id, bucketId));
    return { exports: results };
  }
  if (kind === 'media') {
    if (!Array.isArray(items) || items.length === 0) throw new Error('exportByKind: items required for media');
    return { exports: [await exportMedia(items, bucketId)] };
  }
  throw new Error(`exportByKind: unknown kind '${kind}'`);
}
