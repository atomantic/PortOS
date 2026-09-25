/**
 * Media-queue admission contract — the refusal codes, the pending-job ceiling,
 * and the errors that carry them.
 *
 * Kept apart from the queue so a producer can recognize a refused admission
 * without importing the queue (creativeDirector/videoExecution.js cannot: the
 * queue dynamically imports it, and a static edge back would close a cycle).
 */
import { ServerError } from '../../lib/errorHandler.js';

// Hard ceiling on WAITING jobs across every lane (#8326). Separate from each
// lane's running concurrency: it bounds the in-memory queue and the snapshot
// every admission rewrites, so a runaway producer cannot grow either without
// limit. Never enforced by eviction — a restored backlog above it is kept and
// only new admissions wait for it to drain.
export const MAX_PENDING_MEDIA_JOBS = 250;

// The job was withdrawn before any dispatch because its snapshot write failed
// (#8325).
export const MEDIA_QUEUE_PERSIST_FAILED = 'MEDIA_QUEUE_PERSIST_FAILED';
// The job was never created: the queue already holds MAX_PENDING_MEDIA_JOBS.
export const MEDIA_QUEUE_FULL = 'MEDIA_QUEUE_FULL';
// A batch preflight asked for more room than the ceiling itself — no amount of
// draining admits it, so it is not a retryable refusal.
export const MEDIA_BATCH_TOO_LARGE = 'MEDIA_BATCH_TOO_LARGE';

const REFUSAL_CODES = new Set([MEDIA_QUEUE_PERSIST_FAILED, MEDIA_QUEUE_FULL]);

/**
 * True when `error` is a refused admission: no job exists and no provider work
 * started, so the submission is definitively not made and may be retried.
 */
export const isMediaAdmissionRefusal = (error) => REFUSAL_CODES.has(error?.code);

/**
 * The queue-full refusal. 429 like the federated provider's MEDIA_PROVIDER_BUSY:
 * capacity, not a fault, and safe to retry once jobs finish.
 */
export function mediaQueueFullError({ pending, requested = 1 }) {
  // A batch bigger than the whole ceiling can never fit, so waiting would not
  // help — say so instead of inviting a retry that always fails.
  if (requested > MAX_PENDING_MEDIA_JOBS) {
    return new ServerError(
      `This batch needs ${requested} jobs but the media queue holds at most ${MAX_PENDING_MEDIA_JOBS} waiting — render a smaller selection.`,
      { status: 400, code: MEDIA_BATCH_TOO_LARGE, context: { retryable: false, requested, maxPendingJobs: MAX_PENDING_MEDIA_JOBS } },
    );
  }
  const room = Math.max(0, MAX_PENDING_MEDIA_JOBS - pending);
  const message = requested > 1 && room > 0
    ? `The media queue has room for ${room} more job(s) but this batch needs ${requested} — try again once some finish.`
    : `The media queue is full (${pending} jobs waiting, limit ${MAX_PENDING_MEDIA_JOBS}) — try again once some finish.`;
  return new ServerError(message, {
    status: 429,
    code: MEDIA_QUEUE_FULL,
    context: { retryable: true, pending, requested, maxPendingJobs: MAX_PENDING_MEDIA_JOBS },
  });
}

/**
 * Re-throwable error for a batch whose admission was refused part-way: the
 * jobs already admitted keep running, so the caller is told how many landed
 * rather than seeing a bare failure (or, worse, a success). Any other error,
 * or a refusal before anything landed, passes through unchanged.
 */
export function partialBatchAdmissionError(error, { admitted, total, noun = 'jobs' }) {
  if (!admitted || !isMediaAdmissionRefusal(error)) return error;
  return new ServerError(`Queued ${admitted} of ${total} ${noun} — ${error.message}`, {
    status: error.status || 503,
    code: error.code,
    context: { ...(error.context || {}), admitted, total },
  });
}
