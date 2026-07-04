/**
 * Music Video scene i2v-clip attach hook (issue #1760, Phase 1).
 *
 * Subscribes to mediaJobEvents and, for each completed VIDEO job that carries
 * `params.musicVideo`, files the resulting history id onto that project scene's
 * `videoHistoryId` — server-side, independent of any mounted client. This is the
 * i2v counterpart to the Phase 1b reference-frame hook
 * (`musicVideoSceneImageHook`): a scene's video is generated from its chosen
 * reference frame via the video route's `image` (i2v) mode, and a long local/
 * Codex render that completes after the director navigated away, refreshed, or
 * moved on still lands on the scene (otherwise the clip reaches the video history
 * but the scene link is lost).
 *
 * Video jobs always ride the mediaJobQueue this hook listens to (there is no
 * synchronous video lane), so — unlike the image hook — there's no inline-attach
 * fallback; every scene clip lands through here.
 *
 * The video history record's id IS the job id (videoGen/local.js: meta.id =
 * jobId), and the `videoGenEvents` 'completed' payload the queue stores as
 * `job.result` carries it as `generationId`. `extractResult` reads
 * `job.result.generationId` and falls back to `job.id` so a runtime that doesn't
 * echo the field still attaches the right clip.
 *
 * The shared completion-hook scaffold (tag-decode, per-project serialization,
 * the newest-render-wins guard, best-effort error handling, idempotent init/
 * reset) lives in `createMediaJobImageHook` (#1791) — generalized to the video
 * `kind` in #1760 Phase 1. This file is just the music-video-video config,
 * structurally identical to its scene-image sibling. Mounted once at server boot
 * from server/index.js (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { updateScene } from './musicVideo/projects.js';
import { musicVideoEvents } from './musicVideo/events.js';

const hook = createMediaJobImageHook({
  label: 'music-video scene-video',
  initLog: '🎬 Music Video scene-video hook initialized',
  kind: 'video',
  tagKey: 'musicVideo',
  // History id = the completed video job's id. The videoGenEvents 'completed'
  // payload (stored as job.result) echoes it as generationId; fall back to
  // job.id so a runtime that omits the field still attaches correctly.
  extractResult: (job) => {
    const videoHistoryId = (typeof job.result?.generationId === 'string' && job.result.generationId)
      || (typeof job.id === 'string' ? job.id : null);
    return videoHistoryId ? { videoHistoryId } : null;
  },
  // Require both ids; the tag is otherwise ambiguous about which scene to file.
  identify: (tag) => (tag?.projectId && tag.sceneId
    ? { projectId: tag.projectId, sceneId: tag.sceneId }
    : null),
  // Serialize per PROJECT: two scene clips for the same project completing close
  // together would otherwise both load→modify→save the one project record (file
  // backend) and the later write would clobber the earlier scene's
  // `videoHistoryId`. Different projects still attach concurrently.
  serializeKey: ({ projectId }) => projectId,
  // Newest-render-wins per scene: a clip kicked off from another client (or after
  // a refresh cleared the local spinner) can complete out of order — drop an
  // older render so it can't overwrite a newer clip.
  sceneKey: ({ projectId, sceneId }) => `${projectId}:${sceneId}`,
  describe: ({ projectId, sceneId }) => `${projectId}/${sceneId}`,
  attach: ({ projectId, sceneId, videoHistoryId }) =>
    updateScene(projectId, sceneId, { videoHistoryId }),
  onAttached: ({ projectId, sceneId, videoHistoryId }) => {
    musicVideoEvents.emit('scene-video', { projectId, sceneId, videoHistoryId });
    console.log(`🎬 music-video scene clip ${projectId.slice(0, 8)}/${sceneId} ← ${videoHistoryId.slice(0, 8)}`);
  },
});

export function initMusicVideoSceneVideoHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
