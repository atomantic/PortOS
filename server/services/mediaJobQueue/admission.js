/**
 * Media-queue admission contract: refusal codes, the pending-job ceiling and their errors.
 * Kept apart from the queue so creativeDirector/videoExecution.js can import it without
 * closing a cycle (the queue dynamically imports that module).
 */
import { ServerError } from '../../lib/errorHandler.js';

// Hard ceiling on WAITING jobs across every lane (#8326): bounds the in-memory queue and
// per-admission snapshot. Never enforced by eviction; a restored backlog above it is kept.
export const MAX_PENDING_MEDIA_JOBS = 250;

// Withdrawn before dispatch because its snapshot write failed (#8325).
export const MEDIA_QUEUE_PERSIST_FAILED = 'MEDIA_QUEUE_PERSIST_FAILED';
// The job was never created: the queue already holds MAX_PENDING_MEDIA_JOBS.
export const MEDIA_QUEUE_FULL = 'MEDIA_QUEUE_FULL';
// Batch larger than the ceiling itself: not retryable.
export const MEDIA_BATCH_TOO_LARGE = 'MEDIA_BATCH_TOO_LARGE';

const REFUSAL_CODES = new Set([MEDIA_QUEUE_PERSIST_FAILED, MEDIA_QUEUE_FULL]);

/**
 * True when `error` is a refused admission: no job exists and no provider work
 * started, so the submission is definitively not made and may be retried.
 */
export const isMediaAdmissionRefusal = (error) => REFUSAL_CODES.has(error?.code);

/** The queue-full refusal: 429 (capacity, not a fault; retry once jobs finish). */
export function mediaQueueFullError({ pending, requested = 1 }) {
  // A batch over the ceiling can never fit; do not invite a retry.
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

/** Error for a batch refused part-way: reports how many landed; other errors pass through. */
export function partialBatchAdmissionError(error, { admitted, total, noun = 'jobs' }) {
  if (!admitted || !isMediaAdmissionRefusal(error)) return error;
  return new ServerError(`Queued ${admitted} of ${total} ${noun} — ${error.message}`, {
    status: error.status || 503,
    code: error.code,
    context: { ...(error.context || {}), admitted, total },
  });
}
