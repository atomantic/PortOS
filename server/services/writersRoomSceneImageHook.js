/**
 * Writers-Room scene-image attach hook (issue #1363).
 *
 * Subscribes to mediaJobEvents and, for each completed image job that carries
 * `params.writersRoom`, files the rendered filename onto that work's analysis
 * snapshot (`sceneImages[sceneId]`) and mirrors it into the work's auto-
 * collection — server-side, independent of any mounted client. This is the
 * durable counterpart to SceneCard / LiveRenderPanel's old generate-then-attach
 * round-trip: a long-running local/Codex render that completes after the user
 * navigated away, refreshed, or moved their cursor still lands on the snapshot
 * (previously the image reached the gallery but the analysis link was lost).
 *
 * Only the async local/Codex lanes ride the media-job queue this hook listens
 * to. The synchronous external SD-API lane returns its filename inline and
 * attaches via the `scene-image` route directly — same split the catalog hook
 * (#1359) documents.
 *
 * On a successful attach the hook emits `writersRoomEvents` 'scene-image', which
 * socket.js bridges to the client so the storyboard boards update reactively.
 *
 * Mounted once at server boot from server/index.js (after the media job queue is
 * running). Best-effort: a bookkeeping miss is logged but never thrown — it must
 * not crash the server or fail the user's render.
 */

import { mediaJobEvents } from './mediaJobQueue/index.js';
import { persistSceneImage } from './writersRoom/evaluator.js';
import { writersRoomEvents } from './writersRoomEvents.js';

// Serialize attaches per analysis FILE (workId:analysisId). Two scene renders
// for the same analysis completing close together would otherwise both
// load→modify→save the one `sceneImages` map and the later write would clobber
// the earlier scene's entry. Chaining each attach onto the prior one for that
// analysis makes the later job merge against the freshest persisted snapshot.
// Different analyses (and different works) still attach concurrently. In-memory
// tail, evicted once settled; lost on restart, which is fine — best-effort.
const attachTails = new Map();

function serializePerAnalysis(key, work) {
  const prev = attachTails.get(key) || Promise.resolve();
  // Run `work` on both fulfil AND reject so a prior failure doesn't stall the chain.
  const next = prev.then(work, work);
  attachTails.set(key, next);
  // Evict once settled, but only if nothing newer has chained on. Swallow here
  // so eviction can't surface as an unhandled rejection — the caller attaches
  // its own `.catch` to the returned promise.
  const evict = () => { if (attachTails.get(key) === next) attachTails.delete(key); };
  next.then(evict, evict);
  return next;
}

let completedHandler = null;

export function initWritersRoomSceneImageHook() {
  // Idempotent: a stray double-init (test reload, future refactor) would
  // otherwise register two listeners and double-file every completed image.
  if (completedHandler) return;

  // EventEmitter does not await async listeners and does not catch their
  // rejections — a throw here would surface as a process-killing unhandled
  // rejection on Node ≥15. Use a sync listener that launches an async IIFE with
  // a top-level catch so this bookkeeping miss can never crash the server.
  completedHandler = (job) => {
    void (async () => {
      if (!job || job.kind !== 'image') return;
      const tag = job.params?.writersRoom;
      if (!tag?.workId || !tag.analysisId || !tag.sceneId) return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;
      // The render filename is `${jobId}.png`; prefer the job id, fall back to
      // stripping the extension so the attach records a stable jobId either way.
      const jobId = typeof job.id === 'string' && job.id ? job.id : filename.replace(/\.png$/, '');
      // The gen prompt IS the scene prompt (buildScenePrompt output), so record
      // it on the attach without the tag having to carry a duplicate copy.
      const prompt = typeof job.params?.prompt === 'string' ? job.params.prompt : null;
      const key = `${tag.workId}:${tag.analysisId}`;

      const result = await serializePerAnalysis(key, () =>
        persistSceneImage(tag.workId, tag.analysisId, { sceneId: tag.sceneId, filename, jobId, prompt }),
      ).catch((err) => {
        console.log(`⚠️ writers-room scene-image hook failed for ${filename} → ${tag.workId}/${tag.sceneId}: ${err?.message || String(err)}`);
        return null;
      });

      if (result?.analysis) {
        // Emit the freshly-stored entry so the client board merges exactly what
        // landed on disk (falling back to the bare fields if the snapshot didn't
        // echo it for some reason).
        const image = result.analysis.sceneImages?.[tag.sceneId] || { filename, jobId, prompt };
        writersRoomEvents.emit('scene-image', {
          workId: tag.workId,
          analysisId: tag.analysisId,
          sceneId: tag.sceneId,
          image,
        });
        console.log(`🎬 writers-room scene image ${tag.workId.slice(0, 8)}/${tag.sceneId} ← ${filename}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ writers-room scene-image hook crashed: ${err?.message || err}`);
    });
  };

  mediaJobEvents.on('completed', completedHandler);
  console.log('🎬 Writers-Room scene-image hook initialized');
}

// Test-only reset so suites that re-init can do so cleanly. Removes the
// previously registered listener so re-init doesn't leak handlers.
export const __testing = {
  reset: () => {
    if (completedHandler) {
      mediaJobEvents.off('completed', completedHandler);
      completedHandler = null;
    }
    attachTails.clear();
  },
};
