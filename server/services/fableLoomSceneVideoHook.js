/**
 * FableLoom scene-video attach hook.
 *
 * Video renders always ride the media-job queue. When a queued local render
 * completes after the editor unmounted, this hook still files its history id
 * onto the scene node, matching the durable image attach path.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { attachNodeVideo } from './fableLoom/records.js';

const hook = createMediaJobImageHook({
  label: 'fableloom scene-video',
  initLog: '🎬 FableLoom scene-video hook initialized',
  kind: 'video',
  tagKey: 'fableLoom',
  extractResult: (job) => {
    const videoHistoryId = (typeof job.result?.generationId === 'string' && job.result.generationId)
      || (typeof job.id === 'string' ? job.id : null);
    return videoHistoryId ? { videoHistoryId } : null;
  },
  identify: (tag) => (tag?.loomId && tag.episodeId && tag.nodeId
    ? { loomId: tag.loomId, episodeId: tag.episodeId, nodeId: tag.nodeId }
    : null),
  serializeKey: ({ loomId }) => loomId,
  sceneKey: ({ loomId, episodeId, nodeId }) => `${loomId}:${episodeId}:${nodeId}`,
  describe: ({ loomId, nodeId }) => `${loomId.slice(0, 13)}/${nodeId.slice(0, 13)}`,
  attach: ({ loomId, episodeId, nodeId, videoHistoryId, job }) =>
    attachNodeVideo(loomId, episodeId, nodeId, {
      videoHistoryId,
      ...(job.params?.visualConditioning ? { visualConditioning: job.params.visualConditioning } : {}),
    }),
  onAttached: ({ loomId, nodeId, videoHistoryId }, result) => {
    if (!result) return;
    console.log(`🎬 fableloom scene video ${loomId.slice(0, 13)}/${nodeId.slice(0, 13)} ← ${videoHistoryId}`);
  },
});

export function initFableLoomSceneVideoHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
