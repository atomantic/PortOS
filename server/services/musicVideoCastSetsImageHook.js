/**
 * Music Video Cast & Sets image attach hook.
 *
 * The Cast & Sets check-in (musicVideo/castAndSetsService.js) queues its
 * reference images — character sheet, expressions, looks, set plates, in-set
 * tests — on the normal image queue with a `musicVideo: { projectId,
 * castAndSets: { key, revision } }` tag. This hook files each finished render
 * back onto that key and lets the stage continue (dispatch the images that
 * were waiting on it, or assemble the sheet), independent of any open client.
 * A failed or cancelled job settles its key as failed (the stage retries it
 * once). The scene-frame hook ignores these jobs: their tag has no `sceneId`.
 *
 * Built on the shared completion-hook scaffold (`createMediaJobImageHook`),
 * which owns the idempotent init, per-project serialization and best-effort
 * error handling. Mounted once at server boot; it only listens.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';

const settle = async (payload) => (await import('./musicVideo/castAndSetsService.js')).onCastAndSetsImageSettled(payload);

const hook = createMediaJobImageHook({
  label: 'music-video cast & sets image',
  initLog: '🎭 Music Video Cast & Sets image hook initialized',
  tagKey: 'musicVideo',
  identify: (tag) => (tag?.projectId && typeof tag.castAndSets?.key === 'string'
    ? { projectId: tag.projectId, key: tag.castAndSets.key, revision: tag.castAndSets.revision }
    : null),
  serializeKey: ({ projectId }) => projectId,
  describe: ({ projectId, key }) => `${projectId}/${key}`,
  attach: ({ projectId, key, revision, filename, job }) => settle({
    projectId, key, revision, filename, productionRunId: job.params?.musicVideo?.productionRunId, productionStepKey: job.params?.musicVideo?.productionStepKey, jobId: typeof job.id === 'string' ? job.id : null,
  }).then((changed) => (changed ? { filename } : null)),
  onAttached: ({ projectId, key, filename }) => {
    console.log(`🎭 music-video cast & sets ${projectId.slice(0, 11)}/${key} ← ${filename}`);
  },
  onTerminal: ({ projectId, key, revision, job }, status) => settle({
    projectId, key, revision, status, productionRunId: job?.params?.musicVideo?.productionRunId, productionStepKey: job?.params?.musicVideo?.productionStepKey, jobId: typeof job?.id === 'string' ? job.id : null, error: job?.error || `The render was ${status}`,
  }),
});

export function initMusicVideoCastSetsImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
