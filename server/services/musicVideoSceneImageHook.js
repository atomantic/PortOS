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
 * The shared completion-hook scaffold (tag-decode, per-project serialization,
 * the newest-render-wins guard, best-effort error handling, idempotent init/
 * reset) lives in `createMediaJobImageHook` (#1791) — this file is just the
 * music-video-specific config. Mounted once at server boot from server/index.js
 * (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { updateScene } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';

const hook = createMediaJobImageHook({
  label: 'music-video scene-image',
  initLog: '🎞️ Music Video scene-image hook initialized',
  tagKey: 'musicVideo',
  // Require both ids; the tag is otherwise ambiguous about which scene to file.
  identify: (tag) => (tag?.projectId && tag.sceneId
    ? { projectId: tag.projectId, sceneId: tag.sceneId }
    : null),
  // Serialize per PROJECT: two scene renders for the same project completing
  // close together would otherwise both load→modify→save the one project record
  // (file backend) and the later write would clobber the earlier scene's
  // `referenceImageId`. Different projects still attach concurrently.
  serializeKey: ({ projectId }) => projectId,
  // Newest-render-wins per scene: the GPU lane is FIFO, but the Codex lane and
  // renders kicked off from another client can complete out of order — drop an
  // older render so it can't overwrite a newer reference frame.
  sceneKey: ({ projectId, sceneId }) => `${projectId}:${sceneId}`,
  describe: ({ projectId, sceneId }) => `${projectId}/${sceneId}`,
  attach: ({ projectId, sceneId, filename }) =>
    updateScene(projectId, sceneId, { referenceImageId: filename }),
  onAttached: ({ projectId, sceneId, filename }) => {
    musicVideoEvents.emit('scene-image', { projectId, sceneId, referenceImageId: filename });
    console.log(`🎞️ music-video scene image ${projectId.slice(0, 8)}/${sceneId} ← ${filename}`);
  },
});

export function initMusicVideoSceneImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
