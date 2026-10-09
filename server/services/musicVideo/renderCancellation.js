import { killWithEscalation } from '../../lib/killWithEscalation.js';

/** Cancel capture or encoding without releasing ownership before settlement. */
export function cancelMusicVideoRenderJob(job, { label }) {
  if (!job) return false;
  if (!job.process) {
    if (job.status !== 'running' || !job.overlayAbort || job.overlayAbort.signal.aborted) return false;
    job.cancelRequested = true;
    job.overlayAbort.abort(new Error('Render cancelled'));
    return true;
  }
  // ffmpeg can handle SIGTERM and exit nonzero with a null close-event signal.
  // Record the request before kill, including a synchronous error/close race.
  job.cancelRequested = true;
  const proc = job.process;
  killWithEscalation(proc, { label, stillRunning: () => job.process === proc });
  return true;
}

/** Classify a nonzero close; a zero exit keeps the renderer's success policy. */
export const isMusicVideoRenderCanceled = (job, signal) =>
  job.cancelRequested === true || signal === 'SIGTERM' || signal === 'SIGKILL';
