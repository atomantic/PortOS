/**
 * The Blender film render queue: each project's waiting shot jobs run by
 * quality (stills, previews, finals), first in, first out within each class,
 * and at most `settings.concurrency` Blender processes render at once across
 * this install. Jobs exist only in memory: nothing starts at boot, and
 * a restart drops what was queued (the frames already rendered stay and the
 * next render resumes them). Cancelling kills the Blender process group and
 * drops queued jobs.
 */
import { maintenance } from '../../../lib/maintenanceAdmission.js';
import { blenderRenderWanted, normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { requireProject } from '../requireProject.js';
import { blenderRefusal } from './workspace.js';
import { readBlenderManifest } from './manifest.js';
import { readBlenderRenders } from './renderIndex.js';
import { requireBlenderFilmTool } from './driver.js';
import { requireFfmpeg } from './encode.js';
import { activeBlenderJobs, blenderJobEntry, createBlenderJob, hasBlenderSync, isBlenderJobActive, updateBlenderJob } from './jobs.js';
import { announceBlenderState } from './record.js';
import { blenderStillFrames, runBlenderShotRender } from './renderJob.js';

// projectId → queued tasks, by quality then oldest first within that quality.
// A task is `{ entry, request, concurrency }`.
const waiting = new Map();
const running = new Set();
const QUALITY_PRIORITY = { still: 0, preview: 1, final: 2 };

function settle(task, error) {
  const { entry, request } = task;
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
    .then(() => settle(task, null), (error) => settle(task, error))
    .finally(() => {
      running.delete(task);
      pump();
    })
    .catch((error) => console.error(`❌ Blender film job ${task.entry.job.id} could not be settled: ${error.message}`));
}

function pump() {
  for (const [projectId, tasks] of waiting) {
    // Same-shot stills share both image names and stills.json. Keep distinct
    // requests, but let each finish its index write before the next one starts.
    while (tasks.length) {
      const next = tasks.findIndex((task) => running.size < task.concurrency && !(task.request.quality === 'still' && [...running].some((active) =>
        active.request.quality === 'still' && active.request.projectId === projectId && active.request.shotId === task.request.shotId)));
      if (next < 0) break;
      start(tasks.splice(next, 1)[0]);
    }
    if (!tasks.length) waiting.delete(projectId);
  }
}

function assertNotSyncing(projectId) {
  if (hasBlenderSync(projectId)) throw blenderRefusal('A sync is running for this film. Wait for it to finish before rendering shots.', 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS', 409);
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
export async function enqueueBlenderRenders(projectId, { shotIds = null, quality, times = null, force = false, onlyStale = false }) {
  assertNotSyncing(projectId);
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
  const renders = still ? null : await readBlenderRenders(projectId, manifest, { project, settings, shots });
  // A sync may have reserved its slot while the project and renders were read.
  assertNotSyncing(projectId);
  const active = new Map(activeBlenderJobs(projectId).filter(({ job }) => job.kind === 'render' && job.quality !== 'still')
    .map((entry) => [`${entry.job.shotId}:${entry.job.quality}`, entry]));
  const jobs = [];
  const skipped = [];
  for (const shot of shots) {
    if (still) {
      if (!blenderStillFrames(shot, settings.fps, times).length) { skipped.push(shot.id); continue; }
    } else {
      const existing = active.get(`${shot.id}:${quality}`);
      if (existing) { jobs.push({ ...existing.job }); continue; }
      if (!blenderRenderWanted(renders[shot.id]?.[quality], { force, onlyStale })) { skipped.push(shot.id); continue; }
    }
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

function cancelEntry(projectId, entry) {
  if (!isBlenderJobActive(entry)) return false;
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
  const entry = blenderJobEntry(projectId, jobId);
  return entry ? cancelEntry(projectId, entry) : false;
}

/** Cancel every active job of a project. */
export function cancelBlenderProjectJobs(projectId) {
  return activeBlenderJobs(projectId).map((entry) => cancelEntry(projectId, entry)).some(Boolean);
}
