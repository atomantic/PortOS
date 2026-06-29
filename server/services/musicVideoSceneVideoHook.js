/**
 * Music Video scene i2v-clip attach hook (issue #1760, Phase 1).
 *
 * Subscribes to mediaJobEvents and, for each completed VIDEO job that carries
 * `params.musicVideo`, files the resulting history id onto that project scene's
 * `videoHistoryId` — server-side, independent of any mounted client. This is
 * the i2v counterpart to the Phase 1b reference-frame hook
 * (`musicVideoSceneImageHook`): a scene's video is generated from its chosen
 * reference frame via the video route's `image` (i2v) mode, and a long local/
 * Codex render that completes after the director navigated away, refreshed, or
 * moved on still lands on the scene (otherwise the clip reaches the video
 * history but the scene link is lost).
 *
 * Video jobs always ride the mediaJobQueue this hook listens to (there is no
 * synchronous video lane), so — unlike the image hook — there's no inline-attach
 * fallback to mirror; every scene clip lands through here.
 *
 * The video history record's id IS the job id (see videoGen/local.js: meta.id =
 * jobId), and the `videoGenEvents` 'completed' payload the queue stores as
 * `job.result` carries it as `generationId`. We read `job.result.generationId`
 * and fall back to `job.id` so a runtime that doesn't echo the field still
 * attaches the right clip.
 *
 * `updateScene` routes through the project store dispatcher, so the attach also
 * emits a `musicVideoProject` record-updated event — the new `videoHistoryId`
 * propagates to subscribed sync peers exactly like a hand edit. On success the
 * hook emits `musicVideoEvents` 'scene-video', which socket.js bridges to the
 * client so the board updates reactively.
 *
 * Mounted once at server boot from server/index.js (after the media job queue is
 * running). Best-effort: a bookkeeping miss is logged but never thrown — it must
 * not crash the server or fail the user's render.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { updateScene } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

// Serialize attaches per PROJECT — same rationale as the reference-frame hook:
// two scene clips for one project completing close together would otherwise
// both load→modify→save the single project record (file backend) and the later
// write would clobber the earlier scene's `videoHistoryId`. Different projects
// still attach concurrently. (Shared per-key queue primitive, #1791.)
const serializePerProject = createKeyCachedQueue();

// Newest render (by job `queuedAt`) attached per scene, so an OLDER clip that
// completes AFTER a newer regenerate can't overwrite the newer one. The GPU
// lane is FIFO, but a render kicked off from another client (or after a refresh
// cleared the local spinner) can complete out of order. Keyed
// `${projectId}:${sceneId}` → queuedAt ISO; read + written inside the
// per-project serialize section so it never races. In-memory best-effort.
const latestAttachedAt = new Map();

let completedHandler = null;

export function initMusicVideoSceneVideoHook() {
  // Idempotent: a stray double-init (test reload, future refactor) would
  // otherwise register two listeners and double-file every completed clip.
  if (completedHandler) return;

  // EventEmitter does not await async listeners and does not catch their
  // rejections — a throw here would surface as a process-killing unhandled
  // rejection on Node ≥15. Use a sync listener that launches an async IIFE with
  // a top-level catch so this bookkeeping miss can never crash the server.
  completedHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'video') return;
      const tag = job.params?.musicVideo;
      if (!tag?.projectId || !tag.sceneId) return;
      // History id = the completed video job's id. The videoGenEvents 'completed'
      // payload (stored as job.result) echoes it as generationId; fall back to
      // job.id so a runtime that omits the field still attaches correctly.
      const videoHistoryId = (typeof job.result?.generationId === 'string' && job.result.generationId)
        || (typeof job.id === 'string' ? job.id : null);
      if (!videoHistoryId) return;
      const { projectId, sceneId } = tag;
      const queuedAt = typeof job.queuedAt === 'string' ? job.queuedAt : null;
      const sceneKey = `${projectId}:${sceneId}`;

      const updated = await serializePerProject(projectId, async () => {
        // Drop an out-of-order older render so it can't clobber a newer clip.
        // Fixed-width UTC ISO timestamps compare chronologically as strings.
        const prevAt = latestAttachedAt.get(sceneKey);
        if (queuedAt && prevAt && queuedAt < prevAt) return null;
        const result = await updateScene(projectId, sceneId, { videoHistoryId });
        if (queuedAt) latestAttachedAt.set(sceneKey, queuedAt);
        return result;
      }).catch((err) => {
        // A 404 here is expected and benign — the project or scene was deleted
        // while its render was in flight. Log and drop; never throw.
        console.log(`⚠️ music-video scene-video hook failed for ${videoHistoryId} → ${projectId}/${sceneId}: ${err?.message || String(err)}`);
        return null;
      });

      if (updated) {
        musicVideoEvents.emit('scene-video', { projectId, sceneId, videoHistoryId });
        console.log(`🎬 music-video scene clip ${projectId.slice(0, 8)}/${sceneId} ← ${videoHistoryId.slice(0, 8)}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ music-video scene-video hook crashed: ${err?.message || err}`);
    });
  };

  mediaJobEvents.on('completed', completedHandler);
  console.log('🎬 Music Video scene-video hook initialized');
}

// Test-only reset so suites that re-init can do so cleanly. Removes the
// previously registered listener so re-init doesn't leak handlers.
export const __testing = {
  reset: () => {
    if (completedHandler) {
      mediaJobEvents.off('completed', completedHandler);
      completedHandler = null;
    }
    serializePerProject.clear();
    latestAttachedAt.clear();
  },
};
