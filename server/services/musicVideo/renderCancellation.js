import { killWithEscalation } from '../../lib/killWithEscalation.js';

/**
 * Cancel capture or encoding without releasing ownership before settlement.
 * Honored for the whole running job, including the gaps between phases where
 * no child process exists; refused only once the job is committing its result
 * (`job.committing`) or has settled.
 */
export function cancelMusicVideoRenderJob(job, { label }) {
  if (!job || job.status !== 'running' || job.committing) return false;
  // ffmpeg can handle SIGTERM and exit nonzero with a null close-event signal.
  // Record the request before kill, including a synchronous error/close race.
  job.cancelRequested = true;
  if (job.overlayAbort && !job.overlayAbort.signal.aborted) job.overlayAbort.abort(new Error('Render cancelled'));
  const proc = job.process;
  if (proc) killWithEscalation(proc, { label, stillRunning: () => job.process === proc });
  return true;
}

/** A cancel arrived (or its abort fired) before the job committed; phase boundaries check this. */
export const isMusicVideoRenderCancelPending = (job) =>
  job.cancelRequested === true || job.overlayAbort?.signal.aborted === true;

/** Classify a nonzero close; a zero exit keeps the renderer's success policy. */
export const isMusicVideoRenderCanceled = (job, signal) =>
  job.cancelRequested === true || signal === 'SIGTERM' || signal === 'SIGKILL';
