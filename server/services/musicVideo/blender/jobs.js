/**
 * Blender film jobs in memory: a sync, one shot render, or a cut assembly.
 * A job is a disposable process; the frames, videos and logs it leaves in the
 * workspace are the durable result. Job identities are not persisted; the
 * queue separately remembers preview/final batch intent and resumes unfinished
 * shots after restart from the frames already on disk.
 *
 * Each change goes out on `musicVideoEvents` as `'blender'`
 * `{ projectId, kind: 'job', job }` (bridged to the `music-video:blender`
 * socket channel), at most four messages a second per job; the terminal state
 * is always sent.
 */
import { randomUUID } from 'node:crypto';
import { musicVideoEvents } from '../events.js';

const FINISHED_KEPT_PER_PROJECT = 20;
const PUBLISH_GAP_MS = 250;
const TERMINAL = new Set(['done', 'error', 'canceled']);

// job id → { projectId, job, abort, lastSent, timer }
const entries = new Map();
// Reserve before sync preparation awaits; queued jobs take over the slot afterward.
const preparingSyncs = new Set();

const send = (entry) => {
  entry.lastSent = Date.now();
  // A socket bridge throwing must not fail the render that reported progress.
  try {
    musicVideoEvents.emit('blender', { projectId: entry.projectId, kind: 'job', job: { ...entry.job } });
  } catch (error) {
    console.error(`❌ Blender film job ${entry.job.id} could not be announced: ${error.message}`);
  }
};

function publish(entry, { now = false } = {}) {
  const wait = PUBLISH_GAP_MS - (Date.now() - entry.lastSent);
  if (now || wait <= 0) {
    clearTimeout(entry.timer);
    entry.timer = null;
    send(entry);
    return;
  }
  // Progress inside the gap is sent once, at its end, with the latest values.
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    send(entry);
  }, wait);
  entry.timer.unref?.();
}

function prune(projectId) {
  const finished = [...entries.values()].filter((entry) => entry.projectId === projectId && TERMINAL.has(entry.job.status));
  for (const entry of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT_PER_PROJECT))) entries.delete(entry.job.id);
}

/** Register a queued job and announce it. Returns its entry (`job`, `abort`). */
export function createBlenderJob(projectId, { kind, shotId = null, quality = null, logFile = null }) {
  const now = new Date().toISOString();
  const job = {
    id: `bj-${randomUUID()}`, kind, status: 'queued',
    ...(shotId ? { shotId } : {}), ...(quality ? { quality } : {}),
    queuedAt: now, startedAt: now, ...(logFile ? { logFile } : {}),
  };
  const entry = { projectId, job, abort: new AbortController(), lastSent: 0, timer: null };
  entries.set(job.id, entry);
  publish(entry, { now: true });
  return entry;
}

/** Apply `change` to a job. A status change is sent at once; frame progress is throttled. */
export function updateBlenderJob(entry, change) {
  const statusChanged = change.status && change.status !== entry.job.status;
  Object.assign(entry.job, change);
  if (statusChanged && change.status === 'running') entry.job.startedAt = new Date().toISOString();
  if (TERMINAL.has(entry.job.status)) {
    entry.job.finishedAt ??= new Date().toISOString();
    publish(entry, { now: true });
    prune(entry.projectId);
    return;
  }
  publish(entry, { now: Boolean(statusChanged) });
}

export const isBlenderJobActive = (entry) => !TERMINAL.has(entry.job.status);

export const blenderJobEntry = (projectId, jobId) => {
  const entry = entries.get(jobId);
  return entry && entry.projectId === projectId ? entry : null;
};

/** Every job entry of a project that has not finished, oldest first. */
export const activeBlenderJobs = (projectId) => [...entries.values()].filter((entry) => entry.projectId === projectId && isBlenderJobActive(entry));

/** Whether sync preparation or its background job owns this project's shot list. */
export const hasBlenderSync = (projectId) => preparingSyncs.has(projectId) || activeBlenderJobs(projectId).some(({ job }) => job.kind === 'sync');

/** Atomically reserve preparation; the caller releases on both success and refusal. */
export function reserveBlenderSync(projectId) {
  if (hasBlenderSync(projectId)) return null;
  preparingSyncs.add(projectId);
  return () => preparingSyncs.delete(projectId);
}

/** What the panel lists: active jobs and the last finished ones, oldest first. */
export const listBlenderJobs = (projectId) => [...entries.values()].filter((entry) => entry.projectId === projectId).map((entry) => ({ ...entry.job }));

/** Test seam: forget every job. */
export function __resetBlenderJobsForTests() {
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear();
  preparingSyncs.clear();
}
