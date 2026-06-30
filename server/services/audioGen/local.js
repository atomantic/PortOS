/**
 * Audio job-kind adapter for the media job queue (#1928).
 *
 * The queue (server/services/mediaJobQueue/index.js) dispatches every job kind
 * through an emitter contract shared with video/image/training:
 * `<kind>Events.emit('completed' | 'failed', { generationId, ... })`, optionally
 * preceded by `'activity'`/`'progress'` events the idle watchdog listens for.
 * `generateMusic` (server/services/pipeline/musicGen.js) is a plain awaited
 * function used directly by the Pipeline Audio routes — it has no queue
 * awareness and no reason to gain any, since it's also called synchronously
 * from a request handler. This module is the thin bridge: it calls the real
 * generator and translates its outcome into the queue's expected events, so
 * adding the `'audio'` job kind required zero changes to the actual generation
 * code path.
 *
 * `onActivity` threads through to `generateMusic`'s sidecar STAGE: lines so the
 * queue's idle watchdog resets on genuine progress instead of a flat timeout —
 * the same posture as the image/video gen modules' stderr-line activity pings.
 */

import { generateMusic } from '../pipeline/musicGen.js';
import { audioGenEvents } from './events.js';

// jobId → AbortController, so cancelJob() can interrupt an in-flight render.
const controllers = new Map();

export async function generateAudio({ jobId, prompt, lyrics, engine, durationSec, modelId, repo }) {
  const controller = new AbortController();
  controllers.set(jobId, controller);
  try {
    const result = await generateMusic({
      prompt,
      lyrics,
      engine,
      durationSec,
      modelId,
      repo,
      signal: controller.signal,
      onActivity: () => audioGenEvents.emit('activity', { generationId: jobId }),
    });
    audioGenEvents.emit('completed', { generationId: jobId, ...result });
  } catch (err) {
    audioGenEvents.emit('failed', { generationId: jobId, error: err.message });
  } finally {
    controllers.delete(jobId);
  }
}

// Cancel: aborts the sidecar via the same AbortSignal generateMusic threads to
// its child process. A no-op if the job already settled (controller removed in
// the `finally` above) — mirrors the other gen modules' cancel() contract.
export function cancel(jobId) {
  controllers.get(jobId)?.abort();
}
