/**
 * Music Video cover art image attach hook.
 *
 * "Make a cover image" (musicVideo/coverArt.js) queues one image on the normal
 * image queue with a `musicVideo: { projectId, coverArt: { requestId } }` tag.
 * This hook files the finished render as a cover source and composes the cover
 * from it, independent of any open client. A failed or cancelled job records
 * why. The scene-frame and Cast & Sets hooks ignore these jobs: their tag has
 * no `sceneId` or `castAndSets`.
 *
 * Built on the shared completion-hook scaffold (`createMediaJobImageHook`).
 * Mounted once at server boot; it only listens.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';

const settle = async (payload) => (await import('./musicVideo/coverArt.js')).onCoverArtImageSettled(payload);

const hook = createMediaJobImageHook({
  label: 'music-video cover art image',
  initLog: '🖼️ Music Video cover art image hook initialized',
  tagKey: 'musicVideo',
  identify: (tag) => (tag?.projectId && typeof tag.coverArt?.requestId === 'string'
    ? { projectId: tag.projectId, requestId: tag.coverArt.requestId }
    : null),
  serializeKey: ({ projectId }) => projectId,
  describe: ({ projectId, requestId }) => `${projectId}/${requestId}`,
  attach: ({ projectId, requestId, filename }) => settle({ projectId, requestId, filename })
    .then((changed) => (changed ? { filename } : null)),
  onAttached: ({ projectId, filename }) => {
    console.log(`🖼️ music-video cover art ${projectId.slice(0, 11)} ← ${filename}`);
  },
  onTerminal: ({ projectId, requestId, job }, status) => settle({
    projectId, requestId, status, error: job?.error || `The render was ${status}`,
  }),
});

export function initMusicVideoCoverArtImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
