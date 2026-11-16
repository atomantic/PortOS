/**
 * Writers-Room scene-image attach hook (issue #1363).
 *
 * Subscribes to mediaJobEvents and, for each completed image job carrying
 * `params.writersRoom`, files the rendered filename onto the work's analysis
 * snapshot (`sceneImages[sceneId]`) and mirrors it into the work's auto-
 * collection, server-side and independent of any mounted client, so a long
 * render finishing after the user navigated away still lands.
 *
 * Only the async local/Codex lanes ride the media-job queue this hook listens
 * to; the synchronous external SD-API lane attaches via the `scene-image` route.
 *
 * On success it emits `writersRoomEvents` 'scene-image', which socket.js bridges
 * to the client. The shared scaffold (tag-decode, per-analysis serialization,
 * newest-render-wins, idempotent init/reset) is `createMediaJobImageHook`
 * (#1791); this file is the writers-room config. Mounted once at boot from
 * server/index.js after the media job queue is running.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { persistSceneImage } from './writersRoom/evaluator.js';
import { writersRoomEvents } from './writersRoomEvents.js';
import { effectiveJobPrompt } from '../lib/federatedMediaWire.js';

// The render filename is `${jobId}.png`; fall back to stripping the extension for a stable jobId.
const deriveJobId = (job, filename) =>
  (typeof job.id === 'string' && job.id ? job.id : filename.replace(/\.png$/, ''));
// The gen prompt IS the scene prompt, so record it without the tag carrying a copy.
// A federated render blanks top-level `prompt` to fail closed (#4683), so read
// through to the marker.
const derivePrompt = (job) => effectiveJobPrompt(job);

const hook = createMediaJobImageHook({
  label: 'writers-room scene-image',
  initLog: '🎬 Writers-Room scene-image hook initialized',
  tagKey: 'writersRoom',
  identify: (tag) => (tag?.workId && tag.analysisId && tag.sceneId
    ? { workId: tag.workId, analysisId: tag.analysisId, sceneId: tag.sceneId }
    : null),
  // Serialize per analysis FILE (workId:analysisId): concurrent scene renders would
  // otherwise load→modify→save the one `sceneImages` map and clobber each other.
  serializeKey: ({ workId, analysisId }) => `${workId}:${analysisId}`,
  // Newest-render-wins per scene frame so an older render can't overwrite a newer one (#1791).
  sceneKey: ({ workId, analysisId, sceneId }) => `${workId}:${analysisId}:${sceneId}`,
  describe: ({ workId, sceneId }) => `${workId}/${sceneId}`,
  attach: ({ workId, analysisId, sceneId, filename, job }) =>
    persistSceneImage(workId, analysisId, {
      sceneId, filename, jobId: deriveJobId(job, filename), prompt: derivePrompt(job),
    }),
  onAttached: ({ workId, analysisId, sceneId, filename, job }, result) => {
    // Emit only when the snapshot actually came back so the client merges a real entry.
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

// Test-only reset.
export const __testing = hook.__testing;
