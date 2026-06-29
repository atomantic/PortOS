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
 * The shared completion-hook scaffold (tag-decode, per-analysis serialization,
 * the newest-render-wins guard, best-effort error handling, idempotent init/
 * reset) lives in `createMediaJobImageHook` (#1791) — this file is just the
 * writers-room-specific config. Mounted once at server boot from server/index.js
 * (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { persistSceneImage } from './writersRoom/evaluator.js';
import { writersRoomEvents } from './writersRoomEvents.js';

// The render filename is `${jobId}.png`; prefer the job id, fall back to
// stripping the extension so the attach records a stable jobId either way.
const deriveJobId = (job, filename) =>
  (typeof job.id === 'string' && job.id ? job.id : filename.replace(/\.png$/, ''));
// The gen prompt IS the scene prompt (buildScenePrompt output), so record it on
// the attach without the tag having to carry a duplicate copy.
const derivePrompt = (job) => (typeof job.params?.prompt === 'string' ? job.params.prompt : null);

const hook = createMediaJobImageHook({
  label: 'writers-room scene-image',
  initLog: '🎬 Writers-Room scene-image hook initialized',
  tagKey: 'writersRoom',
  identify: (tag) => (tag?.workId && tag.analysisId && tag.sceneId
    ? { workId: tag.workId, analysisId: tag.analysisId, sceneId: tag.sceneId }
    : null),
  // Serialize per analysis FILE (workId:analysisId): two scene renders for the
  // same analysis completing close together would otherwise both
  // load→modify→save the one `sceneImages` map and the later write would clobber
  // the earlier scene's entry. Different analyses (and works) attach concurrently.
  serializeKey: ({ workId, analysisId }) => `${workId}:${analysisId}`,
  // Newest-render-wins per scene frame so an older render that completes after a
  // newer regenerate can't overwrite the newer storyboard frame (#1791).
  sceneKey: ({ workId, analysisId, sceneId }) => `${workId}:${analysisId}:${sceneId}`,
  describe: ({ workId, sceneId }) => `${workId}/${sceneId}`,
  attach: ({ workId, analysisId, sceneId, filename, job }) =>
    persistSceneImage(workId, analysisId, {
      sceneId, filename, jobId: deriveJobId(job, filename), prompt: derivePrompt(job),
    }),
  onAttached: ({ workId, analysisId, sceneId, filename, job }, result) => {
    // persistSceneImage normally returns { analysis, collectionId }; only emit
    // when the snapshot actually came back so the client merges a real entry.
    if (!result?.analysis) return;
    const image = result.analysis.sceneImages?.[sceneId]
      || { filename, jobId: deriveJobId(job, filename), prompt: derivePrompt(job) };
    writersRoomEvents.emit('scene-image', { workId, analysisId, sceneId, image });
    console.log(`🎬 writers-room scene image ${workId.slice(0, 8)}/${sceneId} ← ${filename}`);
  },
});

export function initWritersRoomSceneImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
