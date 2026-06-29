/**
 * Music Video scene reference-frame attach hook (issue #1760, Phase 1b).
 *
 * Subscribes to mediaJobEvents and, for each completed image job that carries
 * `params.musicVideo`, files the rendered filename onto that project scene's
 * `referenceImageId` — server-side, independent of any mounted client. This is
 * the durable counterpart to the director board's optimistic generate-then-
 * attach: a long-running local/Codex render that completes after the user
 * navigated away, refreshed, or moved their cursor still lands on the scene
 * (otherwise the image reaches the gallery but the scene link is lost).
 *
 * Only the async local/Codex lanes ride the media-job queue this hook listens
 * to. The synchronous external SD-API lane returns its filename inline and the
 * client PATCHes `referenceImageId` directly — the same split the writers-room
 * (#1363) and catalog (#1359) hooks document.
 *
 * `updateScene` routes through the project store dispatcher, so the attach also
 * emits a `musicVideoProject` record-updated event — the new `referenceImageId`
 * propagates to subscribed sync peers exactly like a hand edit. On success the
 * hook emits `musicVideoEvents` 'scene-image', which socket.js bridges to the
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

// Serialize attaches per PROJECT. Two scene renders for the same project
// completing close together would otherwise both load→modify→save the one
// project record (file backend) and the later write would clobber the earlier
// scene's `referenceImageId`. Chaining each attach onto the prior one for that
// project makes the later job merge against the freshest persisted record.
// Different projects still attach concurrently. (Shared per-key queue —
// writers-room + catalog scene-image hooks use the same primitive.)
const serializePerProject = createKeyCachedQueue();

let completedHandler = null;

export function initMusicVideoSceneImageHook() {
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
      const tag = job.params?.musicVideo;
      if (!tag?.projectId || !tag.sceneId) return;
      const filename = job.result?.filename;
      if (!filename || typeof filename !== 'string') return;
      const { projectId, sceneId } = tag;

      const updated = await serializePerProject(projectId, () =>
        updateScene(projectId, sceneId, { referenceImageId: filename }),
      ).catch((err) => {
        // A 404 here is expected and benign — the project or scene was deleted
        // while its render was in flight. Log and drop; never throw.
        console.log(`⚠️ music-video scene-image hook failed for ${filename} → ${projectId}/${sceneId}: ${err?.message || String(err)}`);
        return null;
      });

      if (updated) {
        musicVideoEvents.emit('scene-image', { projectId, sceneId, referenceImageId: filename });
        console.log(`🎞️ music-video scene image ${projectId.slice(0, 8)}/${sceneId} ← ${filename}`);
      }
    })().catch((err) => {
      // Last-resort net for synchronous throws (unexpected job shape, etc).
      console.log(`⚠️ music-video scene-image hook crashed: ${err?.message || err}`);
    });
  };

  mediaJobEvents.on('completed', completedHandler);
  console.log('🎞️ Music Video scene-image hook initialized');
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
  },
};
