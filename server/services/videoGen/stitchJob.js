/**
 * Hand stitching as a media job (#13000). The concat runs ffmpeg for as long as
 * the clips are long, so `POST /api/video-gen/stitch` queues it and returns the
 * job; the new gallery row lands when the worker finishes.
 *
 * Cancel handles live in this module rather than the shared `videoJobState`:
 * a stitch child is not a GPU render, so `videoGen.cancel()` must never kill
 * it (same split as upscaleJob.js). Chained and continuous renders keep calling
 * `stitchVideos` in-process with their own id and never come through here.
 */

import { enqueueJob, listJobs } from '../mediaJobQueue/index.js';
import { videoGenEvents } from './events.js';
import { stitchVideos } from './stitchVideos.js';

export const STITCH_JOB_KIND = 'video-stitch';

// jobId → { abort } for the in-flight worker run.
const activeStitches = new Map();
const pendingAdmissions = new Map();

const stitchKey = (videoIds) => videoIds.join(',');

/**
 * Queue a stitch of `videoIds` (in order). A queued or running job for the same
 * ordered ids is returned instead of starting a second encode and a second row.
 */
export async function enqueueStitch(videoIds) {
  const key = stitchKey(videoIds);
  const pending = pendingAdmissions.get(key);
  if (pending) return { ...await pending, deduplicated: true };
  const live = listJobs({ kind: STITCH_JOB_KIND })
    .find((j) => (j.status === 'queued' || j.status === 'running') && j.params?.stitchKey === key);
  if (live) return { jobId: live.id, position: live.position, status: live.status, deduplicated: true };
  const admission = enqueueJob({
    kind: STITCH_JOB_KIND,
    params: {
      videoIds,
      stitchKey: key,
      prompt: `Stitch ${videoIds.length} videos`,
    },
  });
  pendingAdmissions.set(key, admission);
  return admission.finally(() => pendingAdmissions.delete(key));
}

// Called by mediaJobQueue's cancelJob and its idle watchdog.
export function cancel(jobId) {
  const entry = activeStitches.get(jobId);
  if (!entry) return false;
  entry.abort.abort();
  return true;
}

/** What the queue worker invokes; settles on the videoGen event bus like upscale. */
export async function runVideoStitch({ jobId, videoIds }) {
  const entry = { abort: new AbortController() };
  activeStitches.set(jobId, entry);
  let result = null;
  let failureReason;
  try {
    videoGenEvents.emit('started', { generationId: jobId, id: jobId, stitchedFrom: videoIds, etaMs: null });
    result = await stitchVideos(videoIds, { id: jobId, signal: entry.abort.signal });
  } catch (err) {
    failureReason = entry.abort.signal.aborted ? 'Canceled while running' : (err.message || 'Stitch failed');
    console.error(`❌ Video stitch ${entry.abort.signal.aborted ? 'canceled' : 'failed'} [${jobId.slice(0, 8)}]: ${failureReason}`);
  } finally {
    activeStitches.delete(jobId);
  }
  if (failureReason) videoGenEvents.emit('failed', { generationId: jobId, error: failureReason });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
  return result;
}
