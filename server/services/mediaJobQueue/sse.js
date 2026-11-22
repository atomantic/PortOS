/**
 * Media job SSE streams: one entry per job id, the broadcast of queue
 * positions, the translation of provider progress events into SSE-wire frames,
 * and attaching an HTTP client to a job's stream. Owns the stream map; the
 * queue reaches it only through these functions.
 */

import { SSE_HEADERS } from '../../lib/sseHeaders.js';
import {
  broadcastSse,
  attachSseClient as attachSse,
  closeJobAfterDelay,
  SSE_CLEANUP_DELAY_MS,
} from '../../lib/sseUtils.js';
import { queue, videoHolds, findJob, swimlanePositions } from './state.js';

// jobId → entry consumed by lib/sseUtils.js#{broadcastSse,attachSseClient,
// closeJobAfterDelay}. Each entry carries `clients: []` and `lastPayload`,
// so we can hand it directly to those helpers. Survives the queued→running
// transition so a client that attached during queue keeps its stream open
// through the render and final completion. Entries are removed after
// SSE_CLEANUP_DELAY_MS by closeJobAfterDelay on terminal events.
const sseJobs = new Map();

export function closeArchivedJobSse(jobId) {
  // End any SSE clients still attached within the SSE_CLEANUP_DELAY_MS grace
  // window before dropping the entry — a bare `sseJobs.delete()` here would
  // leave their HTTP responses dangling because closeJobAfterDelay's pending
  // timer would find no entry to drain when it fires.
  const sseEntry = sseJobs.get(jobId);
  if (sseEntry) {
    for (const c of sseEntry.clients) c.end();
    sseJobs.delete(jobId);
  }
}

// Recompute queue positions and notify each waiting SSE client of its new
// slot. Called whenever the queue layout shifts (job dequeued, finished, or
// canceled mid-queue). Without the broadcast, a client connected to
// /:jobId/events would keep showing the position from its original enqueue
// frame even after the line ahead of it cleared.
export function recomputeQueuePositions() {
  videoHolds.updateQueued(queue);
  for (const [q, newPosition] of swimlanePositions()) {
    if (q.position === newPosition) continue;
    q.position = newPosition;
    const entry = sseJobs.get(q.id);
    if (entry) broadcastSse(entry, { type: 'queued', position: newPosition });
  }
}

// Filter videoGenEvents/imageGenEvents down to a single jobId and translate
// them into SSE-wire payloads + queue-status transitions. Returns
// `{ attach, detach }` so runJob can deterministically clean up listeners
// even on the throw path.
//
// Event shapes (match the underlying gens):
//   videoGen.progress  → { generationId, progress: number, step?, totalSteps? }
//   imageGen.progress  → { generationId, progress: number, step?, totalSteps? }
//   imageGen.progress  → { generationId, currentImage } (preview-only frames)
// `message` is synthesized from `step` / `totalSteps` so the existing UIs
// (which display `msg.message` as the status line) keep working through
// the queue, even though the underlying emitters don't supply one.
function synthesizeMessage(e, verb) {
  if (typeof e.step === 'number' && typeof e.totalSteps === 'number' && e.totalSteps > 0) {
    return `${verb} step ${e.step}/${e.totalSteps}`;
  }
  return undefined;
}
// `verb` is the job kind's progress verb (MEDIA_JOB_RUNTIME in index.js).
export function makeGenDispatcher(emitter, job, handlers, verb) {
  const onProgress = (e) => {
    if (e.generationId !== job.id) return;
    const hasProgress = typeof e.progress === 'number' && Number.isFinite(e.progress);
    const hasCurrentImage = typeof e.currentImage === 'string' && e.currentImage.length > 0;
    const message = e.message !== undefined ? e.message : synthesizeMessage(e, verb);
    // Structured step/loss ride along on the wire when the emitter supplies
    // them (LoRA training does) so the client plots a loss curve and keys
    // sample thumbnails by step instead of re-parsing the message string.
    // Additive + presence-guarded — image/video gen omit them, unaffected.
    // `etaMs` (video gen, #3801) rides along the same way: a history-calibrated
    // wall-clock estimate for the whole render. Presence-guarded on purpose —
    // an install with no matching measurement emits no key at all, which the
    // UI must show as "unknown" rather than as a zero countdown.
    // `phase` (video gen, #5872) is the runner's own STAGE: id — 'load-model',
    // 'encode-prompt', 'sampling', 'mux', … The client turns it into a named
    // render step so a runner that reports no numeric progress for minutes
    // (FastH3 streams an ~89 GB DiT before its first denoise step) still says
    // WHAT it is doing rather than showing a motionless 0%.
    const addFrameFields = (payload) => {
      if (typeof e.step === 'number') payload.step = e.step;
      if (typeof e.totalSteps === 'number') payload.totalSteps = e.totalSteps;
      if (typeof e.loss === 'number') payload.loss = e.loss;
      if (typeof e.etaMs === 'number') payload.etaMs = e.etaMs;
      if (typeof e.phase === 'string' && e.phase) payload.phase = e.phase;
    };
    if (hasProgress) {
      const payload = { type: 'progress', progress: e.progress };
      if (hasCurrentImage) payload.currentImage = e.currentImage;
      if (message !== undefined) payload.message = message;
      addFrameFields(payload);
      handlers.progress(payload);
      return;
    }
    if (hasCurrentImage) {
      // Preview-only frame (imageGen step thumbnail) — distinct SSE type so
      // existing consumers can keep their progress-bar value untouched.
      const payload = { type: 'preview', currentImage: e.currentImage };
      if (message !== undefined) payload.message = message;
      addFrameFields(payload);
      handlers.progress(payload);
    }
  };
  const onStatus = (e) => {
    // Optional explicit `status` event for gens that want to push a status
    // line independent of progress. Unused today; here so a future emitter
    // can call `videoGenEvents.emit('status', { generationId, message })`.
    if (e.generationId !== job.id) return;
    if (typeof e.message === 'string' && e.message.length > 0) {
      const payload = { type: 'status', message: e.message };
      if (typeof e.phase === 'string' && e.phase) payload.phase = e.phase;
      handlers.progress(payload);
    }
  };
  const onCompleted = (e) => { if (e.generationId === job.id) handlers.completed(e); };
  const onFailed = (e) => { if (e.generationId === job.id) handlers.failed(e); };
  return {
    attach() {
      emitter.on('progress', onProgress);
      emitter.on('status', onStatus);
      emitter.on('completed', onCompleted);
      emitter.on('failed', onFailed);
    },
    detach() {
      emitter.off('progress', onProgress);
      emitter.off('status', onStatus);
      emitter.off('completed', onCompleted);
      emitter.off('failed', onFailed);
    },
  };
}

export function ensureSseEntry(jobId) {
  if (!sseJobs.has(jobId)) {
    // Shape required by lib/sseUtils.js#{broadcastSse,attachSseClient}.
    sseJobs.set(jobId, { clients: [], lastPayload: null });
  }
  return sseJobs.get(jobId);
}

// Routes call this. Returns false when the jobId is unknown to the queue.
//
// Three cases:
// 1. Live job (queued/running) — sseJobs already has an entry created by
//    enqueueJob; attach replays lastPayload (queued/started/progress).
// 2. Terminal job within the SSE_CLEANUP_DELAY_MS grace window — entry is
//    still around with the terminal lastPayload (complete/error/canceled),
//    so attach immediately replays + the deferred close ends the stream.
// 3. Terminal job after the grace window — entry is gone; we synthesize a
//    one-shot terminal frame from the archived job and end the stream so
//    a late client doesn't hang on an empty SSE stream forever.
export function attachSseClient(jobId, res) {
  const job = findJob(jobId);
  if (!job) return false;
  if (sseJobs.has(jobId)) return attachSse(sseJobs, jobId, res);
  // No SSE entry but the job is still live (queued/running) — the entry was
  // dropped or never created (e.g. crash recovery). Create one on the fly
  // and attach so the client receives subsequent progress/terminal events
  // rather than a synthetic `error` frame for a job that is still running.
  if (job.status === 'queued' || job.status === 'running') {
    const entry = ensureSseEntry(jobId);
    // Seed a heartbeat so the freshly-attached client sees the current
    // status immediately instead of waiting for the next worker emit.
    const heartbeat = job.status === 'queued'
      ? { type: 'queued', position: job.position }
      : { type: 'started', kind: job.kind };
    broadcastSse(entry, heartbeat);
    return attachSse(sseJobs, jobId, res);
  }
  // Terminal job whose SSE entry was already cleaned up. Synthesize the
  // expected terminal payload from the archived state and end immediately.
  const terminal =
    job.status === 'completed' ? { type: 'complete', result: job.result }
    : job.status === 'canceled' ? { type: 'canceled', reason: job.error || 'Canceled' }
    : { type: 'error', error: job.error || `Job ${job.status}` };
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify(terminal)}\n\n`);
  res.end();
  return true;
}

// Publish a job's terminal frame, then drop its stream after the grace window.
export function broadcastTerminalSse(jobId, payload) {
  const entry = ensureSseEntry(jobId);
  broadcastSse(entry, payload);
  closeJobAfterDelay(sseJobs, jobId, SSE_CLEANUP_DELAY_MS, entry);
}

// A fresh stream for a new attempt under the same id (see requeueRetainedReservation).
export function replaceSseEntry(jobId, lastPayload) {
  sseJobs.set(jobId, { clients: [], lastPayload });
}

export function resetSseForTests() {
  sseJobs.clear();
}
