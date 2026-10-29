/** Collection of job-owned quick-edit snapshots with durable settlement proof. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rmdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PATHS, atomicWrite, renameGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { readJSONFileStrict, unreadableStoreError } from '../../lib/jsonIo.js';
import { collectReferencedRefBasenames, ORPHAN_REF_MAX_AGE_MS } from '../imageRefsGc.js';
import { isSnapshotStaging, readOwnedSnapshot, snapshotAnchorPath, validSnapshotIdentity, withReviewedSnapshotLock } from './reviewedReference.js';

export function sweepReviewedReferences({ now = Date.now(), maxAgeMs = ORPHAN_REF_MAX_AGE_MS } = {}) {
  return withReviewedSnapshotLock(async () => {
    const entries = await readdir(PATHS.imageRefs).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const manifests = entries.filter(name => /^snapshot-[0-9a-f-]+\.json$/i.test(name));
    if (!manifests.length) return { deleted: 0 };
    const queuePath = join(PATHS.data, 'media-jobs.json');
    const queue = await readJSONFileStrict(queuePath, { jobs: [] }, { logError: false });
    if (!queue.ok || !Array.isArray(queue.value?.jobs) || queue.value.jobs.some(job => !job || typeof job !== 'object'
      || typeof job.id !== 'string' || !['queued', 'running', 'completed', 'failed', 'canceled'].includes(job.status)
      || !job.params || typeof job.params !== 'object' || Array.isArray(job.params))) throw unreadableStoreError(queuePath);
    // A missing gallery is not proof that a previously published sidecar has
    // no references: the directory may be temporarily unavailable for repair.
    await readdir(PATHS.images);
    const referenced = await collectReferencedRefBasenames(PATHS.images);
    let deleted = 0;
    for (const name of manifests) {
      const path = join(PATHS.imageRefs, name);
      const record = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
      if (!validSnapshotIdentity(record) || name !== `snapshot-${record.snapshotId}.json`
        || !['reserved', 'settled', 'deleting'].includes(record.state) || isSnapshotStaging(record.snapshotId)) continue;
      if (referenced.has(record.filename)) continue;
      // A published or partially retained output without its sidecar cannot
      // prove that provenance is absent. Hold the input until it is resolved.
      const output = await lstat(join(PATHS.images, `${record.jobId}.png`)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (output) continue;
      const jobs = queue.value.jobs;
      if (jobs.some(job => job?.id === record.jobId && ['queued', 'running'].includes(job.status))) continue;
      if (jobs.some(job => job?.id !== record.jobId && [job?.params?.initImagePath, job?.params?.sourceImagePath, job?.params?.sourceImageFile, job?.params?.lastImagePath, job?.params?.lastImageFile, ...(Array.isArray(job?.params?.remoteMedia?.inputAssets) ? job.params.remoteMedia.inputAssets.map(asset => asset?.path) : []), ...(Array.isArray(job?.params?.reviewedReferenceRequest?.referenceImagePaths) ? job.params.reviewedReferenceRequest.referenceImagePaths : []), ...(Array.isArray(job?.params?.referenceImagePaths) ? job.params.referenceImagePaths : [])]
        .some(input => typeof input === 'string' && basename(input) === record.filename))) continue;
      // An interrupted or mismatched quarantine is retained for inspection.
      // Never infer ownership of a lone leftover file after a restart.
      if (record.state === 'deleting') continue;
      const imagePath = join(PATHS.imageRefs, record.filename);
      const info = await lstat(imagePath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) continue;
      if (now - info.mtimeMs < maxAgeMs) continue;
      const owned = await readOwnedSnapshot(record).catch(() => null);
      if (!owned) continue;
      const anchorPath = snapshotAnchorPath(record.snapshotId);
      const handle = await open(anchorPath, 'r').catch(() => null);
      if (!handle) continue;
      try {
        const pinned = await handle.stat({ bigint: true });
        if (!pinned.isFile() || String(pinned.dev) !== record.dev || String(pinned.ino) !== record.ino) continue;
        const quarantine = `snapshot-gc-${randomUUID()}`;
        const directory = join(PATHS.imageRefs, quarantine);
        await mkdir(directory, { mode: 0o700 });
        // Record the location before moving either name. The open handle keeps
        // the inode allocated until all authorized unlinks have finished.
        await atomicWrite(path, { ...record, state: 'deleting', quarantine });
        const movedImage = join(directory, 'image');
        const movedAnchor = join(directory, 'anchor');
        await renameGuarded(imagePath, movedImage);
        await renameGuarded(anchorPath, movedAnchor);
        const [image, anchor, bytes] = await Promise.all([
          lstat(movedImage, { bigint: true }), lstat(movedAnchor, { bigint: true }), readFile(movedImage),
        ]);
        const matches = stat => stat.isFile() && String(stat.dev) === record.dev && String(stat.ino) === record.ino;
        if (!matches(image) || !matches(anchor) || createHash('sha256').update(bytes).digest('hex') !== record.digest) continue;
        await unlinkGuarded(movedImage);
        await unlinkGuarded(movedAnchor);
        await rmdir(directory);
        await unlinkGuarded(path);
        deleted += 1;
      } finally {
        await handle.close();
      }
    }
    return { deleted };
  });
}
