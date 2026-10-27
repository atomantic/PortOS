/**
 * FableLoom scene-image attach hook.
 *
 * Subscribes to mediaJobEvents and, for each completed image job carrying
 * `params.fableLoom`, files the rendered filename onto that loom episode's
 * scene node — server-side, independent of any mounted client, so a long
 * queued local/Codex render that completes after the user navigated away
 * still lands on the node. Same durable-attach split as the writers-room
 * scene hook (#1363): only the async lanes ride the queue; the synchronous
 * external SD-API lane returns its filename inline and the client PATCHes the
 * node directly.
 *
 * The shared completion-hook scaffold (tag-decode, per-record serialization,
 * newest-render-wins, best-effort error handling, idempotent init/reset)
 * lives in `createMediaJobImageHook` — this file is just the FableLoom
 * config. Mounted once at server boot from services/bootstrap.js (after the
 * media job queue is running).
 */

import { createMediaJobImageHook, deriveRenderJobId } from './mediaJobImageHook.js';
import { attachNodeImage } from './fableLoom/records.js';
import { readImageSidecar } from './imageGen/local.js';

/** Preserve the tuple actually executed, not the defaults that happened to be queued. */
async function conditioningForCompletedImage(job, filename) {
  const conditioning = job.params?.visualConditioning;
  if (!conditioning) return null;
  const backend = conditioning.capability?.backend;
  const parameters = { ...(conditioning.render?.parameters || {}) };
  let renderedPrompt;
  if (backend === 'local') {
    const { metadata } = await readImageSidecar(filename).catch(() => ({ metadata: null }));
    if (metadata?.filename === filename && metadata.modelId === conditioning.capability?.modelId) {
      for (const key of ['width', 'height', 'steps', 'guidance', 'quantize', 'seed']) {
        if (metadata[key] != null) parameters[key] = metadata[key];
      }
      renderedPrompt = metadata.renderPrompt ?? metadata.prompt;
      if (metadata.omittedInputImages?.length) {
        return { ...conditioning, status: 'degraded', render: { ...conditioning.render, parameters } };
      }
    }
  } else if (typeof job.params?.mode === 'string') {
    parameters.mode = job.params.mode;
  }
  return {
    ...conditioning,
    ...(typeof renderedPrompt === 'string' ? { renderedPrompt } : {}),
    render: { ...conditioning.render, parameters },
  };
}

const hook = createMediaJobImageHook({
  label: 'fableloom scene-image',
  initLog: '🧶 FableLoom scene-image hook initialized',
  tagKey: 'fableLoom',
  identify: (tag) => (tag?.loomId && tag.episodeId && tag.nodeId
    ? { loomId: tag.loomId, episodeId: tag.episodeId, nodeId: tag.nodeId }
    : null),
  // Writes already serialize per loom via the record write queue; keying the
  // hook per loom keeps its retry/ordering bookkeeping aligned with that.
  serializeKey: ({ loomId }) => loomId,
  // Newest-render-wins per node so an older render completing after a newer
  // regenerate can't overwrite the newer scene image.
  sceneKey: ({ loomId, episodeId, nodeId }) => `${loomId}:${episodeId}:${nodeId}`,
  describe: ({ loomId, nodeId }) => `${loomId.slice(0, 13)}/${nodeId.slice(0, 13)}`,
  attach: async ({ loomId, episodeId, nodeId, filename, job }) => {
    const visualConditioning = await conditioningForCompletedImage(job, filename);
    return attachNodeImage(loomId, episodeId, nodeId, {
      filename,
      jobId: deriveRenderJobId(job, filename),
      ...(visualConditioning ? { visualConditioning } : {}),
    });
  },
  onAttached: ({ loomId, nodeId, filename }, result) => {
    if (!result) return;
    console.log(`🧶 fableloom scene image ${loomId.slice(0, 13)}/${nodeId.slice(0, 13)} ← ${filename}`);
  },
});

export function initFableLoomSceneImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
