/** Retire regenerable renders without touching source takes or the cutting-room floor. */
import { unlink, stat, lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { PATHS, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { join, basename } from 'node:path';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { listProjects, withProjectMediaMutation } from './projects.js';
import { requireProject } from './requireProject.js';
import { withRenderCleanupReservation } from './renderCleanupActivity.js';
export { assertRenderCleanupIdle, withRenderCleanupReservation } from './renderCleanupActivity.js';
import { musicVideoEvents } from './events.js';
import { loadHistory, mutateVideoHistory, HISTORY_UNCHANGED } from '../videoGen/history.js';

// Filesystem recovery metadata is local to these generated videos, never federated.
const JOURNAL = join(PATHS.videos, '.music-video-render-cleanup.json');
const cleanupWrites = createFileWriteQueue();
async function readPending() {
  const journal = await readJSONFile(JOURNAL, { version: 1, entries: [] }, { strict: true });
  if (journal?.version !== 1 || !Array.isArray(journal.entries)
    || journal.entries.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.filename !== 'string')) {
    throw new ServerError('Render cleanup recovery metadata is unreadable', { status: 409, code: 'RENDER_CLEANUP_JOURNAL_INVALID' });
  }
  return journal.entries;
}
const savePending = pending => pending.length
  ? atomicWrite(JOURNAL, { version: 1, entries: pending }) : remove(JOURNAL);
const retirementEntries = (history, pending) => {
  const pendingIds = new Set(pending.map(entry => entry.id));
  // Never collapse conflicting journal rows or replace their recovery evidence.
  return [...pending, ...history.filter(entry => !pendingIds.has(entry.id))];
};
const FINAL_MODELS = new Set(['music-video', 'music-video-code', 'music-video-document', 'music-video-eidoverse']);
const identityConflict = (entry, history, pending) => {
  // Also refuse filename aliases on the supported case-insensitive filesystems.
  const sharesIdentity = other => other.id === entry.id || other.filename?.toLowerCase() === entry.filename?.toLowerCase();
  const rows = history.filter(sharesIdentity);
  const journal = pending.filter(sharesIdentity);
  return rows.length > 1 || journal.length > 1 || [...rows, ...journal].some(other => !isDeepStrictEqual(entry, other));
};

async function upscaleRecoveryReason(entry, history, pending) {
  if (identityConflict(entry, history, pending)) return 'Conflicting history or cleanup journal ID or filename';
  const path = safeUnder(PATHS.videos, entry.filename);
  if (!entry.id || !FINAL_MODELS.has(entry.modelId) || typeof entry.upscaledFrom !== 'string' || !path) return 'Upscale ownership or filename is uncertain';
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return 'Upscaled video file is missing';
  if (!info.isFile() || !info.size) return 'Upscaled video is not a nonempty regular file';
  return null;
}

// Include legacy and nested references (takes, proof, kits, clone provenance).
const references = (value, ids) => {
  if (typeof value === 'string') {
    if (ids.has(value)) return true;
    const path = /^https?:\/\//.test(value) && URL.canParse(value) ? new URL(value).pathname : value.split(/[?#]/, 1)[0];
    return ids.has(path);
  }
  return value && typeof value === 'object' && Object.values(value).some(child => references(child, ids));
};
const size = async path => path ? stat(path).then(info => info.size, error => {
  if (error.code === 'ENOENT') return 0;
  throw error;
}) : 0;
const remove = async path => {
  if (!path) return;
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
};
const renderFiles = entry => [safeUnder(PATHS.videos, entry.filename),
  safeUnder(PATHS.videoThumbnails, entry.thumbnail),
  safeUnder(PATHS.videoThumbnails, entry.filename?.replace(/\.mp4$/, '-proof.png')),
  ...Array.from({ length: 9 }, (_, i) => safeUnder(PATHS.videoThumbnails, `${entry.id}-f${i + 1}.jpg`)),
].filter(Boolean);

async function finalInventory(projectId, history, pending = [], boardOwners = null, loomOwners = null) {
  const project = await requireProject(projectId);
  const [{ listCollections }, timeline, director, { listBoards }, { isPublishKitBuildActive }, { isDcpActive }, { listJobs }, looms] = await Promise.all([
    import('../mediaCollections.js'), import('../videoTimeline/local.js'), import('../creativeDirector/local.js'),
    import('../moodBoard/db.js'),
    import('./publishKit.js'), import('./dcp.js'), import('../mediaJobQueue/index.js'),
    import('../fableLoom/store.js'),
  ]);
  // Completed run receipts describe history, rather than a live media dependency.
  const projects = (await listProjects()).map(({ productionRuns, autonomousRun, ...record }) => ({
    ...record, productionRuns: productionRuns?.filter(run => run.status !== 'completed'),
    autonomousRun: autonomousRun?.status === 'completed' ? null : autonomousRun,
  }));
  const owners = [projects, listJobs().filter(job => ['queued', 'running'].includes(job.status)),
    ...(await Promise.all([listCollections(), timeline.listProjects(), director.listProjects(), boardOwners ?? listBoards(),
      loomOwners ?? looms.listRaw().then(records => records.filter(record => record?.deleted !== true))]))].flat();
  const kitActive = isPublishKitBuildActive(projectId) || isDcpActive(projectId);
  const current = history.find(entry => entry.id === project.renderHistoryId);
  const hasCurrent = current && await size(safeUnder(PATHS.videos, current.filename)) > 0;
  const finals = [];
  const pendingIds = new Set(pending.map(entry => entry.id));
  for (const entry of retirementEntries(history, pending)) {
    // One status per identity; conflicting journal rows remain intact on disk.
    if (finals.some(other => other.id === entry.id)) continue;
    // Upscales are independent deliverables, even when they inherit their
    // source master's music-video tags. They are not obsolete final renders.
    if (entry.upscaledFrom) {
      if (pendingIds.has(entry.id) && entry.musicVideoProjectId === projectId) {
        const reason = await upscaleRecoveryReason(entry, history, pending);
        finals.push({ id: entry.id, pending: true, filename: entry.filename, createdAt: entry.createdAt, bytes: (await Promise.all(renderFiles(entry).map(size))).reduce((a, b) => a + b, 0), recoverable: !reason, reason: reason || 'Upscaled deliverable retained; ready to restore to video history' });
      }
      continue;
    }
    // Only the full-render pipeline owns this tag. Source clips use musicVideo.projectId.
    if (entry.musicVideoProjectId !== projectId || !FINAL_MODELS.has(entry.modelId) || entry.id === project.renderHistoryId) continue;
    const ids = new Set([entry.id, `video:${entry.filename}`]);
    for (const path of renderFiles(entry)) {
      const name = basename(path);
      const base = path === safeUnder(PATHS.videos, entry.filename) ? '/data/videos' : '/data/video-thumbnails';
      for (const identity of [name, path, `${base}/${name}`, `${base}/${encodeURIComponent(name)}`]) ids.add(identity);
    }
    const referenced = owners.some(owner => references(owner, ids))
      || [...history, ...pending].some(other => other.id !== entry.id && references(other, ids));
    const reason = identityConflict(entry, history, pending) ? 'Conflicting history or cleanup journal ID or filename'
      : !hasCurrent ? 'No completed replacement' : kitActive ? 'In use by a publishing-kit or cinema-package build' : referenced ? 'Referenced by saved media or production records' : null;
    finals.push({ id: entry.id, pending: pendingIds.has(entry.id), filename: entry.filename, createdAt: entry.createdAt, bytes: (await Promise.all(renderFiles(entry).map(size))).reduce((a, b) => a + b, 0), reason });
  }
  return { project, finals };
}

/** Called only after the replacement has been published. Failed writes keep old renders. */
export async function cleanupSupersededFinals(projectId, { replacementId = null, reserved = false } = {}) {
  // One writer owns the shared journal across history commits and file retirement.
  const retire = () => cleanupWrites(() => withBackupAssetPublication(async () => {
    const { withBoardMediaReferences } = await import('../moodBoard/db.js');
    const { withLoomMediaReferences } = await import('../fableLoom/store.js');
    return withProjectMediaMutation(() => withBoardMediaReferences(boardOwners => withLoomMediaReferences(async loomOwners => {
      let pending = await readPending();
      let retiring = [];
      let recovering = [];
      let retainedFiles;
      let removed = 0;
      return (async () => {
        await mutateVideoHistory(async history => {
          const entries = retirementEntries(history, pending);
          const { project, finals } = await finalInventory(projectId, history, pending, boardOwners, loomOwners);
          if (replacementId && project.renderHistoryId !== replacementId) return HISTORY_UNCHANGED;
          const recoverable = new Set(finals.filter(entry => entry.recoverable).map(entry => entry.id));
          recovering = pending.filter(entry => recoverable.has(entry.id));
          const restored = recovering.filter(entry => !history.some(other => other.id === entry.id));
          const eligible = new Set(finals.filter(entry => !entry.reason).map(entry => entry.id));
          retiring = entries.filter(entry => eligible.has(entry.id));
          if (!retiring.length) return restored.length ? [...restored, ...history] : HISTORY_UNCHANGED;
          retainedFiles = new Set(entries.filter(entry => !eligible.has(entry.id)).flatMap(renderFiles));
          for (const entry of retiring) {
            if (!safeUnder(PATHS.videos, entry.filename)) throw new ServerError('Invalid render filename', { status: 409, code: 'INVALID_VIDEO_PATH' });
            if (!pending.includes(entry)) pending.push(entry);
          }
          // Recovery evidence precedes every index/history/byte mutation. The
          // history stops advertising a render before any of its bytes disappear.
          await savePending(pending);
          const { unindexVideo } = await import('../mediaAssetIndex/index.js');
          for (const entry of retiring) await unindexVideo(entry.id, { strict: true });
          return [...restored, ...history.filter(entry => !eligible.has(entry.id))];
        });
        // Only a resolved history publication authorizes settling recovery.
        // Failure here leaves the original journal on disk; retry recognizes
        // the exact restored rows without appending or overwriting them again.
        pending = pending.filter(entry => !recovering.includes(entry));
        if (!retiring.length) {
          if (recovering.length) await savePending(pending);
          return 0;
        }
        await (async () => {
          for (const entry of retiring) {
            for (const path of renderFiles(entry)) if (!retainedFiles.has(path)) await remove(path);
            pending = pending.filter(other => other !== entry);
            removed += 1;
          }
        })().finally(() => savePending(pending));
        return removed;
      })().finally(() => { if (retiring.length || recovering.length) musicVideoEvents.emit('render-cleanup', { projectId }); });
    })));
  }));
  return reserved ? retire() : withRenderCleanupReservation(projectId, retire);
}

export async function getRenderCleanup(projectId, options) {
  const [history, pending] = await Promise.all([loadHistory(), readPending()]);
  const { finals } = await finalInventory(projectId, history, pending);
  const { getSegmentCleanup } = await import('./shotSegments.js');
  return { finals, segments: await getSegmentCleanup(projectId, options) };
}

export async function cleanupRenders(projectId, { unusedLooks = false } = {}) {
  return withRenderCleanupReservation(projectId, async () => {
    const { isProjectRenderActive } = await import('./render.js');
    const { cleanupShotSegments, assertSegmentCleanupIdle } = await import('./shotSegments.js');
    if (isProjectRenderActive(projectId)) throw new ServerError('Wait for the final render to finish before cleanup.', { status: 409, code: 'RENDER_IN_PROGRESS' });
    assertSegmentCleanupIdle(projectId);
    await cleanupSupersededFinals(projectId, { reserved: true });
    await cleanupShotSegments(projectId, { unusedLooks, reserved: true });
    musicVideoEvents.emit('render-cleanup', { projectId });
    return getRenderCleanup(projectId);
  });
}
