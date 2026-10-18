/** Retire regenerable renders without touching source takes or the cutting-room floor. */
import { unlink, stat } from 'node:fs/promises';
import { PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { getProject, listProjects, withProjectMediaMutation } from './projects.js';
import { musicVideoEvents } from './events.js';
import { loadHistory, mutateVideoHistory, HISTORY_UNCHANGED } from '../videoGen/history.js';

const cleaning = new Set();
export function assertRenderCleanupIdle(projectId) {
  if (cleaning.has(projectId)) throw new ServerError('Render cleanup is in progress. Try again when it finishes.', { status: 409, code: 'RENDER_CLEANUP_ACTIVE' });
}

// Include legacy and nested references (takes, proof, kits, clone provenance).
const references = (value, ids) => typeof value === 'string' ? ids.has(value)
  : value && typeof value === 'object' && Object.values(value).some(child => references(child, ids));
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

async function finalInventory(projectId, history) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const [{ listCollections }, timeline, director] = await Promise.all([
    import('../mediaCollections.js'), import('../videoTimeline/local.js'), import('../creativeDirector/local.js'),
  ]);
  // Completed run receipts describe history, rather than a live media dependency.
  const projects = (await listProjects()).map(({ productionRuns, autonomousRun, ...record }) => ({
    ...record, productionRuns: productionRuns?.filter(run => run.status !== 'completed'),
    autonomousRun: autonomousRun?.status === 'completed' ? null : autonomousRun,
  }));
  const owners = [projects, ...(await Promise.all([listCollections(), timeline.listProjects(), director.listProjects()]))].flat();
  const current = history.find(entry => entry.id === project.renderHistoryId);
  const hasCurrent = current && await size(safeUnder(PATHS.videos, current.filename)) > 0;
  const finals = [];
  for (const entry of history) {
    // Only the full-render pipeline owns this tag. Source clips use musicVideo.projectId.
    if (entry.musicVideoProjectId !== projectId || !['music-video', 'music-video-code', 'music-video-document', 'music-video-eidoverse'].includes(entry.modelId) || entry.id === project.renderHistoryId) continue;
    const ids = new Set([entry.id, entry.filename]);
    const referenced = owners.some(owner => references(owner, ids))
      || history.some(other => other !== entry && references(other, ids));
    const reason = !hasCurrent ? 'No completed replacement' : referenced ? 'Referenced by saved media or production records' : null;
    finals.push({ id: entry.id, filename: entry.filename, createdAt: entry.createdAt, bytes: (await Promise.all(renderFiles(entry).map(size))).reduce((a, b) => a + b, 0), reason });
  }
  return { project, finals };
}

/** Called only after the replacement has been published. Failed writes keep old renders. */
export async function cleanupSupersededFinals(projectId, { replacementId = null } = {}) {
  return withBackupAssetPublication(() => withProjectMediaMutation(async () => {
    const deleted = [];
    await mutateVideoHistory(async history => {
      const { project, finals } = await finalInventory(projectId, history);
      if (replacementId && project.renderHistoryId !== replacementId) return HISTORY_UNCHANGED;
      const eligible = new Set(finals.filter(entry => !entry.reason).map(entry => entry.id));
      const retainedFiles = new Set(history.filter(entry => !eligible.has(entry.id)).flatMap(renderFiles));
      const index = eligible.size ? await import('../mediaAssetIndex/index.js') : null;
      for (const entry of history) {
        if (!eligible.has(entry.id)) continue;
        if (!safeUnder(PATHS.videos, entry.filename)) throw new ServerError('Invalid render filename', { status: 409, code: 'INVALID_VIDEO_PATH' });
        // Leave the row and bytes available to retry if its derived index cannot settle.
        await index.unindexVideo(entry.id, { strict: true });
        for (const path of renderFiles(entry)) if (!retainedFiles.has(path)) await remove(path);
        deleted.push(entry.id);
      }
      return deleted.length ? history.filter(entry => !eligible.has(entry.id)) : HISTORY_UNCHANGED;
    });
    if (deleted.length) musicVideoEvents.emit('render-cleanup', { projectId });
    return deleted.length;
  }));
}

export async function getRenderCleanup(projectId) {
  const { finals } = await finalInventory(projectId, await loadHistory());
  const { getSegmentCleanup } = await import('./shotSegments.js');
  return { finals, segments: await getSegmentCleanup(projectId) };
}

export async function withRenderCleanupReservation(projectId, work) {
  assertRenderCleanupIdle(projectId);
  cleaning.add(projectId);
  try { return await work(); } finally { cleaning.delete(projectId); }
}

export async function cleanupRenders(projectId, { unusedLooks = false } = {}) {
  return withRenderCleanupReservation(projectId, async () => {
    const { isProjectRenderActive } = await import('./render.js');
    const { cleanupShotSegments, assertSegmentCleanupIdle } = await import('./shotSegments.js');
    if (isProjectRenderActive(projectId)) throw new ServerError('Wait for the final render to finish before cleanup.', { status: 409, code: 'RENDER_IN_PROGRESS' });
    assertSegmentCleanupIdle(projectId);
    await cleanupSupersededFinals(projectId);
    await cleanupShotSegments(projectId, { unusedLooks, reserved: true });
    musicVideoEvents.emit('render-cleanup', { projectId });
    return getRenderCleanup(projectId);
  });
}
