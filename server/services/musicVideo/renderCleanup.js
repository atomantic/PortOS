/** Retire regenerable renders without touching source takes or the cutting-room floor. */
import { unlink, stat } from 'node:fs/promises';
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
const savePending = pending => pending.size
  ? atomicWrite(JOURNAL, { version: 1, entries: [...pending.values()] }) : remove(JOURNAL);
const retirementEntries = (history, pending) => [...new Map([...pending, ...history].map(entry => [entry.id, entry])).values()];

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
  const [{ listCollections }, timeline, director, { listBoards }, { isPublishKitBuildActive }, { listJobs }, looms] = await Promise.all([
    import('../mediaCollections.js'), import('../videoTimeline/local.js'), import('../creativeDirector/local.js'),
    import('../moodBoard/db.js'),
    import('./publishKit.js'), import('../mediaJobQueue/index.js'),
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
  const kitActive = isPublishKitBuildActive(projectId);
  const current = history.find(entry => entry.id === project.renderHistoryId);
  const hasCurrent = current && await size(safeUnder(PATHS.videos, current.filename)) > 0;
  const finals = [];
  const pendingIds = new Set(pending.map(entry => entry.id));
  for (const entry of retirementEntries(history, pending)) {
    // Only the full-render pipeline owns this tag. Source clips use musicVideo.projectId.
    if (entry.musicVideoProjectId !== projectId || !['music-video', 'music-video-code', 'music-video-document', 'music-video-eidoverse'].includes(entry.modelId) || entry.id === project.renderHistoryId) continue;
    const ids = new Set([entry.id, `video:${entry.filename}`]);
    for (const path of renderFiles(entry)) {
      const name = basename(path);
      const base = path === safeUnder(PATHS.videos, entry.filename) ? '/data/videos' : '/data/video-thumbnails';
      for (const identity of [name, path, `${base}/${name}`, `${base}/${encodeURIComponent(name)}`]) ids.add(identity);
    }
    const referenced = owners.some(owner => references(owner, ids))
      || history.some(other => other.id !== entry.id && references(other, ids));
    const reason = !hasCurrent ? 'No completed replacement' : kitActive ? 'In use by a publishing-kit build' : referenced ? 'Referenced by saved media or production records' : null;
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
      const pending = new Map((await readPending()).map(entry => [entry.id, entry]));
      let retiring = [];
      let retainedFiles;
      let removed = 0;
      return (async () => {
        await mutateVideoHistory(async history => {
          const entries = retirementEntries(history, [...pending.values()]);
          const { project, finals } = await finalInventory(projectId, history, [...pending.values()], boardOwners, loomOwners);
          if (replacementId && project.renderHistoryId !== replacementId) return HISTORY_UNCHANGED;
          const eligible = new Set(finals.filter(entry => !entry.reason).map(entry => entry.id));
          retiring = entries.filter(entry => eligible.has(entry.id));
          if (!retiring.length) return HISTORY_UNCHANGED;
          retainedFiles = new Set(entries.filter(entry => !eligible.has(entry.id)).flatMap(renderFiles));
          for (const entry of retiring) {
            if (!safeUnder(PATHS.videos, entry.filename)) throw new ServerError('Invalid render filename', { status: 409, code: 'INVALID_VIDEO_PATH' });
            pending.set(entry.id, entry);
          }
          // Recovery evidence precedes every index/history/byte mutation. The
          // history stops advertising a render before any of its bytes disappear.
          await savePending(pending);
          const { unindexVideo } = await import('../mediaAssetIndex/index.js');
          for (const entry of retiring) await unindexVideo(entry.id, { strict: true });
          return history.filter(entry => !eligible.has(entry.id));
        });
        if (!retiring.length) return 0;
        await (async () => {
          for (const entry of retiring) {
            for (const path of renderFiles(entry)) if (!retainedFiles.has(path)) await remove(path);
            pending.delete(entry.id);
            removed += 1;
          }
        })().finally(() => savePending(pending));
        return removed;
      })().finally(() => { if (retiring.length) musicVideoEvents.emit('render-cleanup', { projectId }); });
    })));
  }));
  return reserved ? retire() : withRenderCleanupReservation(projectId, retire);
}

export async function getRenderCleanup(projectId) {
  const [history, pending] = await Promise.all([loadHistory(), readPending()]);
  const { finals } = await finalInventory(projectId, history, pending);
  const { getSegmentCleanup } = await import('./shotSegments.js');
  return { finals, segments: await getSegmentCleanup(projectId) };
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
