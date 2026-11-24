/**
 * Blender film jobs in memory: a sync, one shot render, or a cut assembly.
 * A job is a disposable process; the frames, videos and logs it leaves in the
 * workspace are the durable result. Job identities are not persisted; the
 * queue separately remembers preview/final batch intent and resumes unfinished
 * shots after restart from the frames already on disk.
 *
 * The registry (throttled `{ kind: 'job', job }` owner events, finished-job
 * retention) is the shared one in ../blenderWorkspace/jobRegistry.js; the sync
 * reservation is film-only.
 */
import { createBlenderJobRegistry } from '../blenderWorkspace/jobRegistry.js';
import { trackedRenderMap } from '../renderActivity.js';
import { filmOwnerKey } from './owner.js';

const registry = createBlenderJobRegistry({ keyOf: filmOwnerKey, label: 'Blender film', keptPerOwner: 20 });
// Running Blender or browser work, for the idle verdict and the update warning.
const liveJobs = trackedRenderMap('film', {
  noun: 'film job',
  link: (_jobId, owner) => (owner.kind === 'music-video' ? `/music-video/${encodeURIComponent(owner.id)}` : null),
});
// Reserve before sync preparation awaits; queued jobs take over the slot afterward.
const preparingSyncs = new Set();

/** Register a queued job and announce it. Returns its entry (`job`, `abort`). */
export const createBlenderJob = (owner, { kind, shotId = null, quality = null, logFile = null }) => registry.create(owner, {
  kind, ...(shotId ? { shotId } : {}), ...(quality ? { quality } : {}), ...(logFile ? { logFile } : {}),
});

/** Apply `change` to a job. A status change is sent at once; frame progress is throttled. */
export function updateBlenderJob(entry, change) {
  registry.update(entry, change);
  if (!registry.isActive(entry)) liveJobs.delete(entry.job.id);
  else if (entry.job.status === 'running') liveJobs.set(entry.job.id, entry.owner);
}

export const isBlenderJobActive = (entry) => registry.isActive(entry);

export const blenderJobEntry = (owner, jobId) => registry.entry(owner, jobId);

/** Every job entry of a project that has not finished, oldest first. */
export const activeBlenderJobs = (owner) => registry.active(owner);

/** Whether sync preparation or its background job owns this project's shot list. */
export const hasBlenderSync = (owner) => preparingSyncs.has(filmOwnerKey(owner)) || activeBlenderJobs(owner).some(({ job }) => job.kind === 'sync');

/** Atomically reserve preparation; the caller releases on both success and refusal. */
export function reserveBlenderSync(owner) {
  if (hasBlenderSync(owner)) return null;
  preparingSyncs.add(filmOwnerKey(owner));
  return () => preparingSyncs.delete(filmOwnerKey(owner));
}

/** What the panel lists: active jobs and the last finished ones, oldest first. */
export const listBlenderJobs = (owner) => registry.list(owner);

/** Test seam: forget every job. */
export function __resetBlenderJobsForTests() {
  registry.reset();
  for (const id of [...liveJobs.keys()]) liveJobs.delete(id);
  preparingSyncs.clear();
}
