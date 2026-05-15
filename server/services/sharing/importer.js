/**
 * Share Bucket — importer.
 *
 * Reads a manifest dropped into `<bucket>/manifests/` and either:
 *   - bucket.mode === 'auto-merge' → apply records into local pipeline /
 *     universe / media state directly, using LWW by updatedAt against any
 *     existing local record of the same id.
 *   - bucket.mode === 'inbox' → write a pending-import entry into
 *     `data/sharing/inbox/<bucketId>.json` for the user to review + promote.
 *
 * Either way the cursor records the manifest filename so the watcher doesn't
 * replay it on restart.
 *
 * Asset blobs referenced by the manifest are copied from the bucket's
 * `assets/{images,videos}/` into the local `data/{images,videos}/` directories
 * (skip-if-present). Media-job records bundled in `records/media/` are merged
 * into `data/media-jobs.json` so re-render workflows have the prompt + params.
 */

import { join, basename } from 'path';
import { copyFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { getBucket } from './buckets.js';
import { readManifest, markProcessed, readCursor, hasBeenProcessed } from './manifest.js';
import { listSeries, createSeries, updateSeries, getSeries } from '../pipeline/series.js';
import { listIssues, createIssue, updateIssue, getIssue } from '../pipeline/issues.js';
import { listUniverses, createUniverse, updateUniverse, getUniverse } from '../universeBuilder.js';

const isStr = (v) => typeof v === 'string';

export const sharingEvents = new EventEmitter();

const inboxPath = (bucketId) => join(PATHS.data, 'sharing', 'inbox', `${bucketId}.json`);

async function readInbox(bucketId) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  return readJSONFile(inboxPath(bucketId), { items: [] }, { logError: false });
}

async function writeInbox(bucketId, inbox) {
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));
  await atomicWrite(inboxPath(bucketId), inbox);
}

/** Newer of two ISO timestamps wins (LWW). Equal → keep local. */
function remoteWins(localTs, remoteTs) {
  return (remoteTs || '') > (localTs || '');
}

/** Copy bundled assets from the bucket into local data dirs. Runs in parallel. */
async function copyAssetsLocally(bucketPath, assetRefs) {
  await ensureDir(PATHS.images);
  await ensureDir(PATHS.videos);
  await Promise.all((assetRefs || []).map(async (ref) => {
    if (!ref || !isStr(ref.ref)) return;
    const filename = basename(ref.ref);
    const isVideo = ref.kind === 'video';
    const sourceDir = join(bucketPath, 'assets', isVideo ? 'videos' : 'images');
    const targetDir = isVideo ? PATHS.videos : PATHS.images;
    const sourcePath = join(sourceDir, filename);
    const targetPath = join(targetDir, filename);
    if (!existsSync(sourcePath)) {
      console.log(`⚠️ sharing.importer: asset ${filename} listed in manifest but missing in bucket`);
      return;
    }
    if (!existsSync(targetPath)) {
      await copyFile(sourcePath, targetPath);
    }
    if (!isVideo) {
      const sidecarBase = filename.replace(/\.(png|jpe?g|webp)$/i, '') + '.metadata.json';
      const sidecarSource = join(sourceDir, sidecarBase);
      if (existsSync(sidecarSource)) {
        const sidecarTarget = join(targetDir, sidecarBase);
        if (!existsSync(sidecarTarget)) await copyFile(sidecarSource, sidecarTarget);
      }
    }
  }));
}

/** Merge bucket-bundled media-job records into local data/media-jobs.json. */
async function mergeMediaJobRecords(bucketPath, recordIds) {
  const mediaDir = join(bucketPath, 'records', 'media');
  if (!existsSync(mediaDir)) return;
  const persistedPath = join(PATHS.data, 'media-jobs.json');
  const [persisted, incoming] = await Promise.all([
    readJSONFile(persistedPath, { jobs: [] }, { logError: false }),
    Promise.all((recordIds || []).map(async (id) => {
      const recordPath = join(mediaDir, `${id}.json`);
      if (!existsSync(recordPath)) return null;
      return readJSONFile(recordPath, null, { logError: false });
    })),
  ]);
  const byId = new Map((persisted.jobs || []).map((j) => [j.id, j]));
  let changed = false;
  for (const job of incoming) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
    changed = true;
  }
  if (changed) {
    await atomicWrite(persistedPath, { jobs: Array.from(byId.values()) });
  }
}

/** Read the records referenced by a manifest. */
async function readReferencedRecords(bucketPath, manifest) {
  const records = { series: [], issues: [], universes: [], media: [] };
  for (const id of manifest.recordIds || []) {
    if (id.startsWith('ser-')) {
      const r = await readJSONFile(join(bucketPath, 'records', 'series', `${id}.json`), null, { logError: false });
      if (r) records.series.push(r);
    } else if (id.startsWith('iss-')) {
      const r = await readJSONFile(join(bucketPath, 'records', 'issues', `${id}.json`), null, { logError: false });
      if (r) records.issues.push(r);
    } else if (id.startsWith('chr-') || id.startsWith('set-') || id.startsWith('obj-')) {
      // Bible entries — never standalone, just skip.
      continue;
    } else {
      // Could be a universe (uuid only) or media job (uuid only). Try both.
      const uni = await readJSONFile(join(bucketPath, 'records', 'universes', `${id}.json`), null, { logError: false });
      if (uni) { records.universes.push(uni); continue; }
      const med = await readJSONFile(join(bucketPath, 'records', 'media', `${id}.json`), null, { logError: false });
      if (med) records.media.push(med);
    }
  }
  return records;
}

/**
 * Auto-merge mode: apply records into live state.
 * LWW: if a record already exists locally with a newer updatedAt, skip;
 * otherwise insert (via createSeries) or patch (via updateSeries).
 */
async function applyAutoMerge(bucket, manifest, records) {
  let applied = 0;

  // Universes first — series may reference them via universeId.
  for (const uni of records.universes) {
    const existing = await getUniverse(uni.id).catch(() => null);
    if (!existing) {
      // No createUniverseWithId() — universeBuilder.createUniverse assigns a
      // fresh UUID. Workaround: write directly through updateUniverse paired
      // with a seed insert via the readState/writeState pair would require
      // exporting an internal helper. For now, fall back to the merge being
      // additive: if we can't recreate, we put it in inbox-equivalent state.
      // The pragmatic v1 path: write the universe with createUniverse and
      // accept that the id changes. We then keep the bucket-id mapping for
      // series.universeId rewiring below.
      const created = await createUniverse(uni).catch(() => null);
      if (created) {
        // Remap series.universeId references in this same manifest.
        for (const s of records.series) {
          if (s.universeId === uni.id) s.universeId = created.id;
        }
        applied++;
      }
      continue;
    }
    if (remoteWins(existing.updatedAt, uni.updatedAt)) {
      await updateUniverse(existing.id, uni);
      applied++;
    }
  }

  // Series.
  for (const s of records.series) {
    const existing = await getSeries(s.id).catch(() => null);
    if (!existing) {
      // createSeries assigns a fresh id — to preserve the manifest's series.id
      // (so subsequent imports of the same series LWW-merge correctly), we
      // need to insert directly. For v1, accept that auto-merge new arrivals
      // get a fresh local id; the origin field still attributes the record.
      const created = await createSeries(s).catch(() => null);
      if (created) {
        // Rewrite issue.seriesId references for this manifest's issues.
        for (const iss of records.issues) {
          if (iss.seriesId === s.id) iss.seriesId = created.id;
        }
        applied++;
      }
      continue;
    }
    if (remoteWins(existing.updatedAt, s.updatedAt)) {
      await updateSeries(existing.id, s);
      applied++;
    }
  }

  // Issues.
  for (const iss of records.issues) {
    const existing = await getIssue(iss.id).catch(() => null);
    if (!existing) {
      await createIssue(iss).catch(() => null);
      applied++;
      continue;
    }
    if (remoteWins(existing.updatedAt, iss.updatedAt)) {
      await updateIssue(existing.id, iss);
      applied++;
    }
  }

  return { applied };
}

const INBOX_MAX = 1000;

/** Inbox mode: write the manifest + record refs to the bucket's inbox for review. */
async function applyInbox(bucket, manifest, manifestFilename, records) {
  const inbox = await readInbox(bucket.id);
  inbox.items = Array.isArray(inbox.items) ? inbox.items : [];
  // Dedup by manifest id.
  if (inbox.items.some((it) => it.manifestId === manifest.id)) {
    return { queued: false, reason: 'already-in-inbox' };
  }
  inbox.items.push({
    manifestId: manifest.id,
    manifestFilename,
    kind: manifest.kind,
    source: manifest.source,
    sourceBio: manifest.sourceBio,
    createdAt: manifest.createdAt,
    receivedAt: new Date().toISOString(),
    recordIds: manifest.recordIds,
    assetCount: (manifest.assetRefs || []).length,
    note: manifest.note,
    summary: summarizeRecords(records),
  });
  // Cap to prevent unbounded growth — a peer dropping thousands of manifests
  // shouldn't blow up the inbox file. Drop the oldest entries.
  if (inbox.items.length > INBOX_MAX) inbox.items = inbox.items.slice(-INBOX_MAX);
  await writeInbox(bucket.id, inbox);
  return { queued: true };
}

function summarizeRecords(records) {
  const out = [];
  for (const s of records.series) out.push({ kind: 'series', id: s.id, label: s.name || s.id });
  for (const i of records.issues) out.push({ kind: 'issue', id: i.id, label: i.title || i.id });
  for (const u of records.universes) out.push({ kind: 'universe', id: u.id, label: u.name || u.id });
  for (const m of records.media) out.push({ kind: 'media', id: m.id, label: m.params?.prompt?.slice?.(0, 80) || m.id });
  return out;
}

/**
 * Process one manifest file. Idempotent: a second call for the same manifest
 * is a no-op (cursor + inbox dedup).
 */
export async function processManifest(bucketId, manifestFilename) {
  const bucket = await getBucket(bucketId);
  const cursor = await readCursor(bucketId);
  if (hasBeenProcessed(cursor, manifestFilename)) {
    return { skipped: true, reason: 'already-processed' };
  }
  const manifest = await readManifest(bucket.path, manifestFilename);
  if (!manifest || !manifest.id) {
    return { skipped: true, reason: 'invalid-manifest' };
  }
  const records = await readReferencedRecords(bucket.path, manifest);

  // Always copy assets + media-job records ahead of the merge so canon and
  // pipeline records that reference them point at present files.
  await copyAssetsLocally(bucket.path, manifest.assetRefs);
  await mergeMediaJobRecords(bucket.path, manifest.recordIds);

  let outcome;
  if (bucket.mode === 'auto-merge') {
    outcome = { mode: 'auto-merge', ...(await applyAutoMerge(bucket, manifest, records)) };
  } else {
    outcome = { mode: 'inbox', ...(await applyInbox(bucket, manifest, manifestFilename, records)) };
  }
  await markProcessed(bucketId, manifestFilename);

  sharingEvents.emit('manifest-processed', { bucketId, manifestId: manifest.id, manifestFilename, outcome });
  console.log(`📥 sharing: bucket=${bucket.name} manifest=${manifest.id} kind=${manifest.kind} mode=${bucket.mode} ${outcome.applied !== undefined ? `applied=${outcome.applied}` : `queued=${outcome.queued}`}`);
  return { processed: true, manifest, outcome };
}

/** On startup or registration, scan the manifests dir for unprocessed entries. */
export async function processBacklog(bucketId) {
  const bucket = await getBucket(bucketId);
  const manifestsDir = join(bucket.path, 'manifests');
  if (!existsSync(manifestsDir)) return { processed: 0 };
  const cursor = await readCursor(bucketId);
  const filenames = (await readdir(manifestsDir).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort();
  let processed = 0;
  for (const f of filenames) {
    if (hasBeenProcessed(cursor, f)) continue;
    const res = await processManifest(bucketId, f).catch((err) => {
      console.log(`⚠️ sharing.importer: processManifest failed for ${f}: ${err.message}`);
      return null;
    });
    if (res?.processed) processed++;
  }
  return { processed };
}

/** Promote a pending inbox item: re-process it via the auto-merge path. */
export async function promoteInboxItem(bucketId, manifestId) {
  const inbox = await readInbox(bucketId);
  const idx = (inbox.items || []).findIndex((it) => it.manifestId === manifestId);
  if (idx < 0) throw Object.assign(new Error(`Inbox item not found: ${manifestId}`), { code: 'SHARING_INBOX_NOT_FOUND' });
  const item = inbox.items[idx];
  const bucket = await getBucket(bucketId);
  const manifest = await readManifest(bucket.path, item.manifestFilename);
  if (!manifest) throw new Error(`Manifest no longer exists in bucket: ${item.manifestFilename}`);
  const records = await readReferencedRecords(bucket.path, manifest);
  await copyAssetsLocally(bucket.path, manifest.assetRefs);
  await mergeMediaJobRecords(bucket.path, manifest.recordIds);
  const outcome = await applyAutoMerge(bucket, manifest, records);
  // Drop from inbox.
  inbox.items.splice(idx, 1);
  await writeInbox(bucketId, inbox);
  sharingEvents.emit('inbox-updated', { bucketId });
  return { promoted: true, outcome };
}

export async function dismissInboxItem(bucketId, manifestId) {
  const inbox = await readInbox(bucketId);
  const before = (inbox.items || []).length;
  inbox.items = (inbox.items || []).filter((it) => it.manifestId !== manifestId);
  if (inbox.items.length === before) throw Object.assign(new Error(`Inbox item not found: ${manifestId}`), { code: 'SHARING_INBOX_NOT_FOUND' });
  await writeInbox(bucketId, inbox);
  sharingEvents.emit('inbox-updated', { bucketId });
  return { dismissed: true };
}

export async function listInbox(bucketId) {
  const inbox = await readInbox(bucketId);
  return Array.isArray(inbox.items) ? inbox.items : [];
}
