/**
 * "Make it vertical" as a media job. The ffmpeg re-encode runs as long as the clip
 * is long, so `POST /api/video-gen/history/:id/vertical` queues it and returns the
 * job; the new gallery row lands when the worker finishes. Cancel handles live here,
 * not in `videoJobState`: this is not a GPU render (same split as stitchJob.js).
 */

import { enqueueJob, listJobs } from '../mediaJobQueue/index.js';
import { ServerError } from '../../lib/errorHandler.js';
import { probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { isAlreadyTallEnough } from '../../lib/verticalReframe.js';
import { videoGenEvents } from './events.js';
import { resolveHistoryItem, resolveSourcePath } from './upscaleVideo.js';
import { verticalReframeHistoryItem } from './verticalReframe.js';

export const VERTICAL_JOB_KIND = 'video-vertical';

const activeExports = new Map();
const pendingAdmissions = new Map();

/**
 * Queue a vertical export of `historyId` at `ratioId`. A clip already as tall as
 * the target is refused up front (400); a queued or running export of the same
 * clip and ratio is returned instead of starting a second encode.
 */
export async function enqueueVertical(historyId, ratioId) {
  const key = `${historyId}:${ratioId}`;
  const pending = pendingAdmissions.get(key);
  if (pending) return { ...await pending, deduplicated: true };
  const live = listJobs({ kind: VERTICAL_JOB_KIND })
    .find((j) => (j.status === 'queued' || j.status === 'running') && j.params?.verticalKey === key);
  if (live) return { jobId: live.id, position: live.position, status: live.status, deduplicated: true };
  // Registered before any await so a concurrent identical request joins this admission.
  const admission = (async () => {
    const item = await resolveHistoryItem(historyId);
    const { width, height } = await probeVideoStreamInfo(resolveSourcePath(item));
    if (isAlreadyTallEnough(width, height, ratioId)) {
      throw new ServerError(`This clip is already as tall as ${ratioId}`, { status: 400, code: 'ALREADY_VERTICAL' });
    }
    return enqueueJob({
      kind: VERTICAL_JOB_KIND,
      params: { historyId, ratio: ratioId, verticalKey: key, prompt: `Make ${ratioId} vertical copy` },
    });
  })();
  pendingAdmissions.set(key, admission);
  return admission.finally(() => pendingAdmissions.delete(key));
}

// Called by mediaJobQueue's cancelJob and its idle watchdog.
export function cancel(jobId) {
  const entry = activeExports.get(jobId);
  if (!entry) return false;
  entry.abort.abort();
  return true;
}

/** What the queue worker invokes; settles on the videoGen event bus like stitch. */
export async function runVideoVertical({ jobId, historyId, ratio }) {
  const entry = { abort: new AbortController() };
  activeExports.set(jobId, entry);
  let result = null;
  let failureReason;
  try {
    videoGenEvents.emit('started', { generationId: jobId, id: jobId, verticalFrom: historyId, etaMs: null });
    result = await verticalReframeHistoryItem(historyId, ratio, { id: jobId, signal: entry.abort.signal });
  } catch (err) {
    const canceled = entry.abort.signal.aborted;
    failureReason = canceled ? 'Canceled while running' : (err.message || 'Vertical export failed');
    if (canceled) console.log(`🛑 Vertical export canceled [${jobId.slice(0, 8)}]: ${failureReason}`);
    else console.error(`❌ Vertical export failed [${jobId.slice(0, 8)}]: ${failureReason}`);
  } finally {
    activeExports.delete(jobId);
  }
  if (failureReason) videoGenEvents.emit('failed', { generationId: jobId, error: failureReason });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
  return result;
}
