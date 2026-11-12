/**
 * The Blender film render queue: each project's waiting shot jobs run by
 * quality (stills, previews, finals), first in, first out within each class,
 * and at most `settings.concurrency` Blender processes render at once across
 * this install. Preview/final batch intent stays on this machine and resumes
 * after restart, bounded to two retries; completed frames are reused. Stills
 * remain memory-only. Cancellation removes intent and kills the process group.
 */
import { createKeyCachedQueue } from '../../../lib/createKeyCachedQueue.js';
import { readPendingBlenderRenders, writePendingBlenderRenders, removePendingBlenderShots } from './pending.js';
import { maintenance } from '../../../lib/maintenanceAdmission.js';
import { blenderRenderWanted, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { requireProject } from '../requireProject.js';
import { blenderRefusal } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { readBlenderRenders } from './renderIndex.js';
import { requireBlenderFilmTool } from './driver.js';
import { requireFfmpeg } from './encode.js';
import { activeBlenderJobs, blenderJobEntry, createBlenderJob, isBlenderJobActive, updateBlenderJob } from './jobs.js';
import { announceBlenderState } from './record.js';
import { blenderStillFrames, runBlenderShotRender } from './renderJob.js';

// projectId → queued tasks, by quality then oldest first within that quality.
// A task is `{ entry, request, concurrency }`.
const queueProject = createKeyCachedQueue();
const waiting = new Map();
const running = new Set();
const QUALITY_PRIORITY = { still: 0, preview: 1, final: 2 };

async function settle(task, error) {
  const { entry, request } = task;
  await removePendingBlenderShots(request.projectId, request.quality, [request.shotId]).catch((failure) => {
    console.error(`❌ Blender film job ${entry.job.id} could not clear pending intent: ${failure.message}`);
  });
  const canceled = error?.canceled === true || (error && entry.abort.signal.aborted);
  if (!error) updateBlenderJob(entry, { status: 'done' });
  else if (canceled) updateBlenderJob(entry, { status: 'canceled' });
  else {
    console.error(`❌ Blender film ${request.quality} render of shot ${request.shotId} failed: ${error.message}`);
    updateBlenderJob(entry, { status: 'error', error: String(error.message || 'Render failed').slice(0, 2000) });
  }
  announceBlenderState(request.projectId);
}

function start(task) {
  running.add(task);
  // Admission can refuse (a maintenance hold); that fails this job like any other error.
  Promise.resolve()
    .then(() => maintenance.run('composition', 'Blender film shot render', () => runBlenderShotRender(task.entry, task.request), { continuation: true }))
    .then(() => queueProject(task.request.projectId, () => settle(task, null)),
      (error) => queueProject(task.request.projectId, () => settle(task, error)))
    .finally(() => {
      running.delete(task);
      pump();
    })
    .catch((error) => console.error(`❌ Blender film job ${task.entry.job.id} could not be settled: ${error.message}`));
}

function pump() {
  for (const [projectId, tasks] of waiting) {
    while (tasks.length && running.size < tasks[0].concurrency) start(tasks.shift());
    if (!tasks.length) waiting.delete(projectId);
  }
}

const unknownShots = (ids) => blenderRefusal(`Not in the synced film: ${ids.join(', ')}. Sync shots from scripts first.`, 'NOT_FOUND', 404, { shotIds: ids });

/**
 * Queue renders for a project. Preview and final take every shot that is not
 * rendered or out of date, and `force` the current ones too; `onlyStale`
 * narrows to renders that exist and are out of date (`blenderRenderWanted`,
 * the rule the panel counts by). Stills always render. Resolves
 * `{ jobs, skipped }`: the jobs now covering the request (a shot already
 * queued or rendering keeps its job) and the shot ids left alone.
 */
export function enqueueBlenderRenders(projectId, options) {
  return queueProject(projectId, () => enqueue(projectId, options));
}

async function enqueue(projectId, { shotIds = null, quality, times = null, force = false, onlyStale = false }) {
  const project = await requireProject(projectId);
  await requireBlenderFilmTool();
  if (quality !== 'still') await requireFfmpeg();
  const { settings } = normalizeBlenderRecord(project.blender);
  const manifest = await readBlenderManifest(projectId);
  if (!manifest?.shots.length) throw blenderRefusal('Sync shots from scripts before rendering', 'MUSIC_VIDEO_BLENDER_NOT_SYNCED', 409);
  // The shots sit on the frame grid they were synced at; at another rate their edges would overlap or gap.
  if (manifest.fps !== settings.fps) {
    throw blenderRefusal(`The frame rate changed from ${manifest.fps} to ${settings.fps} since the last sync. Sync shots from scripts again before rendering.`, 'MUSIC_VIDEO_BLENDER_NOT_SYNCED', 409);
  }
  const known = new Map(manifest.shots.map((shot) => [shot.id, shot]));
  const missing = (shotIds || []).filter((id) => !known.has(id));
  if (missing.length) throw unknownShots(missing);
  const shots = shotIds ? [...new Set(shotIds)].map((id) => known.get(id)) : manifest.shots;
  const still = quality === 'still';
  const renders = still ? null : await readBlenderRenders(projectId, manifest, { settings, shots });
  const active = new Map(activeBlenderJobs(projectId).filter(({ job }) => job.kind === 'render' && job.quality !== 'still')
    .map((entry) => [`${entry.job.shotId}:${entry.job.quality}`, entry]));
  const jobs = [];
  const skipped = [];
  const selected = [];
  for (const shot of shots) {
    if (still) {
      if (!blenderStillFrames(shot, settings.fps, times).length) { skipped.push(shot.id); continue; }
    } else {
      const existing = active.get(`${shot.id}:${quality}`);
      if (existing) { jobs.push({ ...existing.job }); continue; }
      if (!blenderRenderWanted(renders[shot.id]?.[quality], { force, onlyStale })) { skipped.push(shot.id); continue; }
    }
    selected.push(shot);
  }
  // Persist before exposing jobs or allowing the pump to start them.
  if (!still) {
    const entries = await readPendingBlenderRenders(projectId);
    const prior = entries.find((entry) => entry.quality === quality);
    const pendingIds = [...new Set([...(prior?.shotIds || []), ...selected.map((shot) => shot.id), ...jobs.map((job) => job.shotId)])]
      .filter((id) => !skipped.includes(id));
    await writePendingBlenderRenders(projectId, [...entries.filter((entry) => entry.quality !== quality),
      { quality, shotIds: pendingIds, attempt: prior?.attempt || 0 }]);
  }
  for (const shot of selected) {
    const entry = createBlenderJob(projectId, { kind: 'render', shotId: shot.id, quality });
    const tasks = waiting.get(projectId) || [];
    const task = { entry, concurrency: settings.concurrency, request: { projectId, shotId: shot.id, quality, force, times } };
    const priority = QUALITY_PRIORITY[quality];
    const insertAt = tasks.findIndex((queued) => QUALITY_PRIORITY[queued.request.quality] > priority);
    tasks.splice(insertAt === -1 ? tasks.length : insertAt, 0, task);
    waiting.set(projectId, tasks);
    jobs.push({ ...entry.job });
  }
  if (still && !jobs.length) throw blenderRefusal('None of the requested times fall inside the selected shots', 'VALIDATION_ERROR');
  pump();
  return { jobs, skipped };
}

async function cancelEntry(projectId, entry) {
  if (!isBlenderJobActive(entry)) return false;
  if (entry.job.kind === 'render') await removePendingBlenderShots(projectId, entry.job.quality, [entry.job.shotId]);
  // The global pump may have started this task while the marker write awaited.
  const tasks = waiting.get(projectId) || [];
  const queued = tasks.findIndex((task) => task.entry === entry);
  entry.abort.abort();
  if (queued >= 0) {
    tasks.splice(queued, 1);
    if (!tasks.length) waiting.delete(projectId);
    updateBlenderJob(entry, { status: 'canceled' });
  }
  return true;
}

/** Cancel one job (queued, rendering, syncing or assembling). False when it is unknown or already finished. */
export function cancelBlenderJob(projectId, jobId) {
  return queueProject(projectId, () => {
    const entry = blenderJobEntry(projectId, jobId);
    return entry ? cancelEntry(projectId, entry) : false;
  });
}

/** Cancel every active job of a project. */
export function cancelBlenderProjectJobs(projectId) {
  return queueProject(projectId, async () => {
    const pending = await readPendingBlenderRenders(projectId);
    await writePendingBlenderRenders(projectId, []);
    let canceled = pending.length > 0;
    for (const entry of activeBlenderJobs(projectId)) canceled = await cancelEntry(projectId, entry) || canceled;
    return canceled;
  });
}


/** Resume only this machine's previously requested batches, under the same mutation lock as cancel/enqueue. */
export async function resumePendingBlenderRenders(projectIds, maxAttempts) {
  for (const projectId of projectIds) {
    await queueProject(projectId, async () => {
      const batches = await readPendingBlenderRenders(projectId);
      for (const batch of batches) {
        // A director may have already started some of these during the boot delay.
        const active = new Set(activeBlenderJobs(projectId).filter(({ job }) => job.quality === batch.quality).map(({ job }) => job.shotId));
        const shotIds = batch.shotIds.filter((id) => !active.has(id));
        if (!shotIds.length) continue;
        if (batch.attempt >= maxAttempts) {
          await removePendingBlenderShots(projectId, batch.quality, shotIds);
          console.log(`⏭️ Blender boot recovery: ${projectId} stopped ${shotIds.length} ${batch.quality} shot(s) at the restart limit`);
          continue;
        }
        const current = await readPendingBlenderRenders(projectId);
        await writePendingBlenderRenders(projectId, current.map((entry) => entry.quality === batch.quality
          ? { ...entry, attempt: entry.attempt + 1 } : entry));
        try {
          const { jobs } = await enqueue(projectId, { shotIds, quality: batch.quality });
          console.log(`🎬 Blender boot recovery: ${projectId} resumed ${jobs.length} ${batch.quality} shot(s)`);
        } catch (error) {
          // A readiness/sync refusal needs operator action. An unexpected DB or
          // filesystem failure must not erase the user's unstarted work.
          const refused = (error.status >= 400 && error.status < 500) || error.code === 'FFMPEG_MISSING';
          if (!refused) {
            console.error(`❌ Blender boot recovery: ${projectId} retained ${shotIds.length} ${batch.quality} shot(s) after an unexpected failure: ${error.message}`);
            continue;
          }
          await removePendingBlenderShots(projectId, batch.quality, shotIds);
          console.log(`⏭️ Blender boot recovery: ${projectId} stopped ${shotIds.length} ${batch.quality} shot(s): ${error.message}`);
        }
      }
    }).catch((error) => console.error(`❌ Blender boot recovery: ${projectId} could not recover pending renders: ${error.message}`));
  }
}
