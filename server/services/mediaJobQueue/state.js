/**
 * The media queue's in-memory state: the waiting queue, each lane's running
 * jobs, the archive, video holds, the event bus, and the terminal-operation
 * tracker. The facade, scheduler, execution, persistence and SSE share it from here.
 * The containers are mutated in place and never reassigned; the GPU lane's
 * single `running` slot is reached through getRunningJob/setRunningJob.
 */

import { EventEmitter } from 'events';
import { isRemoteMediaJob } from './remoteMediaJob.js';
import { createVideoHolds } from './videoHolds.js';
import { jobSwimlane } from './limits.js';

// A restored remote submission reconnecting to peer work it already admitted.
export const isRemoteReconcile = (job) => isRemoteMediaJob(job) && job.params?.remoteMedia?.reconcile === true;

export const isTopazUpscale = (job) => job.kind === 'video-upscale' && job.params?.mode === 'topaz';

export const mediaJobEvents = new EventEmitter();
// Boot already wires 11 permanent `completed` hooks (universe-builder, catalog
// image-attach, writers-room, music-video scene image/video, music bed, sprite
// references, scene frames, and the comicPages/storyboards/seasonCover filename
// hooks), which trips Node's default limit of 10 and prints a bogus
// MaxListenersExceededWarning on every start. These are long-lived subscribers,
// not a leak; per-job waiters add more on top. Matches the caps the sibling
// emitters already set (imageGenEvents 200, videoGenEvents 50).
mediaJobEvents.setMaxListeners(100);

// GPU lane: serialized — `running` holds at most one job. Cloud CLI and remote
// provider lanes are parallel because neither consumes the local GPU. `queue`
// preserves submission order across lanes; positions are swim-lane-scoped.
export const queue = [];
let running = null;
export const cloudRunning = [];
export const remoteRunning = [];
export const archive = [];
export const videoHolds = createVideoHolds();

export function getRunningJob() {
  return running;
}

export function setRunningJob(job) {
  running = job;
}

export const recoveryState = { initPromise: null, inventoryReady: false };
export const testLifecycleDisposals = new Set();
export const laneOperations = new Set();

// Track async pre-dispatch work separately so the test drain can wait for
// provider invocation without waiting for provider settlement (#9029).
export const dispatchOperations = new Set();

export const terminalOperations = new Set();

export function trackOperation(operations, operation) {
  const tracked = Promise.resolve(operation);
  operations.add(tracked);
  tracked.finally(() => operations.delete(tracked)).catch(() => {});
  return tracked;
}

export const trackTerminalOperation = (operation) => trackOperation(terminalOperations, operation);

export function findJob(jobId) {
  if (running && running.id === jobId) return running;
  const codexHit = cloudRunning.find((j) => j.id === jobId);
  if (codexHit) return codexHit;
  const remoteHit = remoteRunning.find((j) => j.id === jobId);
  if (remoteHit) return remoteHit;
  const inQueue = queue.find((j) => j.id === jobId);
  if (inQueue) return inQueue;
  return archive.find((j) => j.id === jobId) || null;
}

export const runningJobs = () => [...(running ? [running] : []), ...cloudRunning, ...remoteRunning];

// Queue position of every waiting job within its own swim lane: running work in
// the swim lane holds the first slots, then queued work in submission order.
export function swimlanePositions() {
  const counts = new Map();
  const bump = (job) => {
    const key = jobSwimlane(job);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    return n;
  };
  runningJobs().forEach(bump);
  return new Map(queue.map((job) => [job, bump(job)]));
}

export function listJobs({ status, kind, owner } = {}) {
  const all = [
    ...(running ? [running] : []),
    ...cloudRunning,
    ...remoteRunning,
    ...queue,
    ...archive,
  ];
  return all.filter((j) => {
    if (status && j.status !== status) return false;
    if (kind && j.kind !== kind) return false;
    if (owner && j.owner !== owner) return false;
    return true;
  });
}

// IDs proven by the boot probe to have an existing trainer; request params cannot grant this.
export const recoveringJobs = new Set();

// Test-only: empty every container in place so held references stay valid.
export function resetQueueStateForTests() {
  queue.length = 0;
  running = null;
  cloudRunning.length = 0;
  remoteRunning.length = 0;
  archive.length = 0;
  videoHolds.clear();
  recoveringJobs.clear();
}
