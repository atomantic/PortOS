/**
 * Music Video scene i2v-clip attach hook (issue #1760, Phase 1).
 *
 * Subscribes to mediaJobEvents and, for each completed VIDEO job that carries
 * `params.musicVideo`, appends the resulting history id to that project scene's
 * immutable takes (#8965) — server-side, independent of any mounted client. The
 * take becomes the scene's `videoHistoryId` only while that slot is still
 * unselected; it never replaces a clip the director already selected. This is the
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
 * best-effort error handling, idempotent init/reset) lives in `createMediaJobImageHook` (#1791) — generalized to the video
 * `kind` in #1760 Phase 1. This file is just the music-video-video config,
 * structurally identical to its scene-image sibling. Mounted once at server boot
 * from server/index.js (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { basename } from 'path';
import { appendSceneTakes } from './musicVideo/projects.js';
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
  // No newest-render-wins guard (#8965): out-of-order clips are all kept as
  // takes, and none of them can displace a selection.
  describe: ({ projectId, sceneId }) => `${projectId}/${sceneId}`,
  // A deleted project/scene 404s here, so a late completion can't resurrect it.
  attach: ({ projectId, sceneId, videoHistoryId, job }) => appendSceneTakes(projectId, sceneId, [{
    kind: 'video',
    assetId: videoHistoryId,
    source: 'generated',
    provider: 'portos',
    jobId: typeof job.id === 'string' ? job.id : null,
    prompt: typeof job.params?.prompt === 'string' ? job.params.prompt : null,
    // The frame this clip was generated from — a basename only; job params
    // carry the server's absolute path, which never belongs on a synced record.
    sourceImageId: typeof job.params?.sourceImagePath === 'string' ? basename(job.params.sourceImagePath) : null,
    // #8977: a performance take keeps the immutable record of the song slice,
    // edit in/out points and capability it was generated against — the
    // renderer places the take by it, so a later retime can't misalign lips.
    shotInstruction: job.params?.shotInstruction ?? null,
    dependencies: job.params?.musicVideoDependencies ?? null,
  }]),
  onAttached: ({ projectId, sceneId, videoHistoryId }, { scene, appended }) => {
    musicVideoEvents.emit('scene-video', {
      projectId,
      sceneId,
      videoHistoryId: scene.videoHistoryId ?? null,
      takes: scene.takes,
      takeId: appended[0]?.takeId ?? null,
    });
    console.log(`🎬 music-video scene clip take ${projectId.slice(0, 8)}/${sceneId} ← ${videoHistoryId.slice(0, 8)}`);
  },
});

export function initMusicVideoSceneVideoHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
