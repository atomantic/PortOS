/** Load referenced records and check whether declared siblings have arrived. */

import { isPlainObject } from '../../lib/objects.js';
import { isStr } from '../../lib/textUtils.js';
import { bucketRecordsDir, bucketRecordPath } from './buckets.js';
import { existsSync } from 'fs';
import { isSafeRecordId } from '../../lib/zodCompat.js';
import { readJSONFile } from '../../lib/fileUtils.js';
import { importArchivedJobs } from '../mediaJobQueue/index.js';

// A bundled media-job record is re-render metadata, never work to resume here:
// the queue replays a persisted `queued` record at boot and re-enqueues some
// `running`/remote ones, so a bucket record must not choose its status, carry
// queue-internal state, or name itself anything but the safe id it was read by.
// Rebuilt to the exporter's field set (exportMediaJobAndAsset).
const IMPORTABLE_MEDIA_JOB_KINDS = new Set(['image', 'video']);
function importableMediaJob(raw, recordId) {
  if (!isPlainObject(raw) || raw.id !== recordId || raw.status !== 'completed') return null;
  if (!IMPORTABLE_MEDIA_JOB_KINDS.has(raw.kind)) return null;
  return {
    id: raw.id,
    kind: raw.kind,
    owner: raw.owner ?? null,
    status: 'completed',
    completedAt: isStr(raw.completedAt) ? raw.completedAt : null,
    params: isPlainObject(raw.params) ? raw.params : {},
    result: isPlainObject(raw.result) ? raw.result : null,
  };
}

/** Hand bucket-bundled media-job records to the media queue, which owns data/media-jobs.json. */
export async function mergeMediaJobRecords(bucketPath, recordIds) {
  const mediaDir = bucketRecordsDir(bucketPath, 'media');
  if (!existsSync(mediaDir)) return;
  const incoming = await Promise.all((recordIds || []).map(async (id) => {
    if (!isSafeRecordId(id)) return null;
    const recordPath = bucketRecordPath(bucketPath, 'media', id);
    if (!existsSync(recordPath)) return null;
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    return importableMediaJob(await readJSONFile(recordPath, null, { logError: false }), id);
  }));
  const records = incoming.filter(Boolean);
  if (records.length) await importArchivedJobs(records);
}

/**
 * Read the records referenced by a manifest. `missing` lists recordIds whose
 * JSON file hasn't synced into the bucket yet — the caller defers
 * markProcessed until that list is empty, otherwise a manifest delivered
 * ahead of its records would be silently dropped forever. Bible-prefixed ids
 * (chr-/set-/obj-) are sub-records of universes and never standalone, so they
 * are skipped without being tracked as missing.
 */
// Declared manuscript-review files (records/reviews/<seriesId>.json) the manifest
// says are bundled but aren't yet readable on disk. Parses each (not just
// existsSync) so a present-but-partial/corrupt file mid-cloud-sync counts as
// "not ready" and keeps the manifest pending — mirroring readReferencedRecords,
// where an unparseable record file is treated as missing. Returns the seriesIds
// still pending; legacy manifests (no reviewRefs) → [].
export async function missingDeclaredReviews(bucketPath, manifest) {
  const refs = (Array.isArray(manifest.reviewRefs) ? manifest.reviewRefs : []).filter(isSafeRecordId);
  const checks = await Promise.all(refs.map(async (sid) => {
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    const r = await readJSONFile(bucketRecordPath(bucketPath, 'reviews', sid), null, { logError: false });
    return r == null ? sid : null;
  }));
  return checks.filter(Boolean);
}

// Declared reverse-outline files (records/outlines/<seriesId>.json) the manifest
// says are bundled but aren't yet readable on disk (#1348). Same parse-not-
// existsSync semantics as missingDeclaredReviews: a present-but-corrupt file mid-
// cloud-sync counts as "not ready" and keeps the manifest pending. Legacy
// manifests (no outlineRefs) → [].
export async function missingDeclaredOutlines(bucketPath, manifest) {
  const refs = (Array.isArray(manifest.outlineRefs) ? manifest.outlineRefs : []).filter(isSafeRecordId);
  const checks = await Promise.all(refs.map(async (sid) => {
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    const r = await readJSONFile(bucketRecordPath(bucketPath, 'outlines', sid), null, { logError: false });
    return r == null ? sid : null;
  }));
  return checks.filter(Boolean);
}

export async function readReferencedRecords(bucketPath, manifest) {
  const records = { series: [], issues: [], universes: [], media: [] };
  const missing = [];
  const resolveOne = async (id) => {
    if (!isSafeRecordId(id)) return { kind: 'missing', id };
    if (id.startsWith('ser-')) {
      // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
      const r = await readJSONFile(bucketRecordPath(bucketPath, 'series', id), null, { logError: false });
      return r ? { kind: 'series', record: r } : { kind: 'missing', id };
    }
    if (id.startsWith('iss-')) {
      // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
      const r = await readJSONFile(bucketRecordPath(bucketPath, 'issues', id), null, { logError: false });
      return r ? { kind: 'issues', record: r } : { kind: 'missing', id };
    }
    if (id.startsWith('chr-') || id.startsWith('set-') || id.startsWith('obj-')) {
      // Bible entries — never standalone, just skip.
      return { kind: 'skip' };
    }
    // UUID-only — could be a universe or a media job. Try both.
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    const uni = await readJSONFile(bucketRecordPath(bucketPath, 'universes', id), null, { logError: false });
    if (uni) return { kind: 'universes', record: uni };
    // Input-only bucket record: unreadable data is skipped/deferred, never written back here.
    const med = await readJSONFile(bucketRecordPath(bucketPath, 'media', id), null, { logError: false });
    if (med) return { kind: 'media', record: med };
    return { kind: 'missing', id };
  };
  const resolved = await Promise.all((manifest.recordIds || []).map(resolveOne));
  for (const r of resolved) {
    // `importDraft` (issue #727) is a LOCAL-only importer-orphan GC marker —
    // never trust an inbound value from a share bucket, or a crafted/stale
    // record could mark a local universe/series GC-eligible. The service
    // sanitizers persist a literal `importDraft: true`, so strip it at this
    // boundary (mirrors the peer-sync merge strip in mergeUniversesFromSync /
    // mergeSeriesFromSync). Only universes + series carry the marker.
    if (r.record && typeof r.record === 'object' && 'importDraft' in r.record) {
      delete r.record.importDraft;
    }
    if (r.kind === 'missing') missing.push(r.id);
    else if (r.kind === 'series') records.series.push(r.record);
    else if (r.kind === 'issues') records.issues.push(r.record);
    else if (r.kind === 'universes') records.universes.push(r.record);
    else if (r.kind === 'media') records.media.push(r.record);
  }
  return { records, missing };
}
