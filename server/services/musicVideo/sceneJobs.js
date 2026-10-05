/**
 * The scene renders a project still has in flight (#10154).
 *
 * The board's per-scene spinners live in React state, so a reload used to drop
 * them while the media-job queue kept rendering (and the completion hooks kept
 * attaching the result). This reads the queue — the one source of truth — for
 * the live image/video jobs tagged with `params.musicVideo.{projectId,sceneId}`
 * so a reloaded board can restore the spinners and not re-submit duplicates
 * (paid ones on fal). Only `queued`/`running` jobs qualify; cast-and-sets jobs
 * carry the same tag key but no `sceneId`, so they are excluded.
 */

import { listJobs } from '../mediaJobQueue/index.js';

const LANE_BY_KIND = Object.freeze({ image: 'image', video: 'video' });

export function listInFlightSceneJobs(projectId) {
  const out = [];
  for (const job of listJobs()) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    const lane = LANE_BY_KIND[job.kind];
    const tag = job.params?.musicVideo;
    if (!lane || tag?.projectId !== projectId || !tag.sceneId) continue;
    out.push({ jobId: job.id, lane, sceneId: tag.sceneId, status: job.status });
  }
  return out;
}
