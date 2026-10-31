/** Reviewed quick-edit references: a job-bound copy and its durable ownership record. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, link } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PATHS, atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new ServerError('The reviewed reference image changed or is unavailable. Review it again before rendering.', { status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
const activeStaging = new Set();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
const manifestPath = id => join(PATHS.imageRefs, `snapshot-${id}.json`);
export const snapshotAnchorPath = id => join(PATHS.imageRefs, `snapshot-${id}.anchor`);

export async function reviewedReferencePreview(path) {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) throw invalid();
  const ext = extname(path).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext];
  if (!mime) throw invalid();
  return { reviewedReferenceDigest: digest(bytes), reviewedReferenceImage: `data:${mime};base64,${bytes.toString('base64')}` };
}

export async function reviewedReferenceDigest(path) {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) throw invalid();
  return digest(bytes);
}

export async function assertReviewedReference(path, expected) {
  if (!sha.test(expected || '') || await reviewedReferenceDigest(path) !== expected) throw invalid();
}

// The manifest precedes the exclusive copy. Neither a pre-existing filename nor
// matching bytes alone proves ownership; the queue also persists this exact tuple.
export async function stageReviewedReference(jobId, source, expected) {
  const bytes = await readFile(source).catch(() => null);
  if (!bytes || !sha.test(expected || '') || digest(bytes) !== expected) throw invalid();
  const snapshotId = randomUUID();
  const extension = extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw invalid();
  const filename = `snapshot-${snapshotId}${extension}`;
  const identity = { jobId, snapshotId, filename, digest: expected };
  activeStaging.add(snapshotId);
  try {
    await mkdir(PATHS.imageRefs, { recursive: true });
    await writeFile(manifestPath(snapshotId), JSON.stringify({ ...identity, state: 'reserved' }), { flag: 'wx', mode: 0o600, flush: true });
    const path = join(PATHS.imageRefs, filename);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400, flush: true });
    // Keep the original inode allocated even if the public path is replaced.
    // An interrupted reservation without the completed record is held by GC.
    await link(path, snapshotAnchorPath(snapshotId));
    const info = await lstat(path, { bigint: true });
    const owned = { ...identity, dev: String(info.dev), ino: String(info.ino), anchorVersion: 1 };
    if (!validSnapshotIdentity(owned)) throw invalid();
    await atomicWrite(manifestPath(snapshotId), { ...owned, state: 'reserved' });
    return owned;
  } finally {
    activeStaging.delete(snapshotId);
  }
}

export function validSnapshotIdentity(identity) {
  return Boolean(identity && uuid.test(identity.jobId || '') && uuid.test(identity.snapshotId || '')
    && identity.anchorVersion === 1
    && sha.test(identity.digest || '') && /^\d+$/.test(identity.dev || '') && /^[1-9]\d*$/.test(identity.ino || '')
    && new RegExp(`^snapshot-${identity.snapshotId}\\.(png|jpg|jpeg|webp)$`, 'i').test(identity.filename || ''));
}

export async function readOwnedSnapshot(identity) {
  if (!validSnapshotIdentity(identity)) throw invalid();
  const record = await readFile(manifestPath(identity.snapshotId), 'utf8').then(JSON.parse).catch(() => null);
  if (!record || ['jobId', 'snapshotId', 'filename', 'digest', 'dev', 'ino', 'anchorVersion'].some(key => record[key] !== identity[key])
    || !['reserved', 'invoked', 'settled', 'deleting'].includes(record.state)) throw invalid();
  const path = join(PATHS.imageRefs, identity.filename);
  const anchor = await lstat(snapshotAnchorPath(identity.snapshotId), { bigint: true }).catch(() => null);
  if (!anchor?.isFile() || String(anchor.dev) !== identity.dev || String(anchor.ino) !== identity.ino) throw invalid();
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (!info?.isFile() || String(info.dev) !== identity.dev || String(info.ino) !== identity.ino) throw invalid();
  const bytes = await readFile(path).catch(() => null);
  const after = await lstat(path, { bigint: true }).catch(() => null);
  const anchorAfter = await lstat(snapshotAnchorPath(identity.snapshotId), { bigint: true }).catch(() => null);
  if (!bytes || digest(bytes) !== identity.digest || !after?.isFile() || String(after.dev) !== identity.dev || String(after.ino) !== identity.ino
    || !anchorAfter?.isFile() || String(anchorAfter.dev) !== identity.dev || String(anchorAfter.ino) !== identity.ino) throw invalid();
  return { record, path, bytes };
}

export async function markSnapshotState(identity, state) {
  const { record } = await readOwnedSnapshot(identity);
  if (state === 'settled' && record.state === 'settled') return;
  if ((state === 'invoked' && record.state !== 'reserved')
    || (state === 'settled' && !['reserved', 'invoked'].includes(record.state))
    || !['invoked', 'settled'].includes(state)) throw invalid();
  await atomicWrite(manifestPath(identity.snapshotId), { ...record, state });
}

export const isSnapshotStaging = id => activeStaging.has(id);

export async function assertSnapshotForAdapter(identity, jobId, initImagePath, referenceImagePaths) {
  const paths = [initImagePath, ...(Array.isArray(referenceImagePaths) ? referenceImagePaths : [])];
  if (!identity) {
    if (paths.some(path => typeof path === 'string' && path.startsWith(join(PATHS.imageRefs, 'snapshot-')))) throw invalid();
    return;
  }
  const { record, path, bytes } = await readOwnedSnapshot(identity);
  if (record.state !== 'invoked' || identity.jobId !== jobId || initImagePath
    || !isReviewedReferenceList(referenceImagePaths, path)) throw invalid();
  return bytes;
}

/**
 * A reviewed edit's references: the job's own snapshot (the image being
 * edited) leads, and any further references are ordinary inputs, never another
 * snapshot.
 */
export function isReviewedReferenceList(referenceImagePaths, snapshotPath) {
  return Array.isArray(referenceImagePaths) && referenceImagePaths[0] === snapshotPath
    && !referenceImagePaths.slice(1).some(path => typeof path !== 'string' || basename(path).startsWith('snapshot-'));
}

let snapshotLock = Promise.resolve();
export function withReviewedSnapshotLock(work) {
  const result = snapshotLock.then(work, work);
  snapshotLock = result.catch(() => {});
  return result;
}
