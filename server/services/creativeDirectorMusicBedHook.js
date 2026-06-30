/**
 * Creative Director music-bed attach hook (#1928).
 *
 * Subscribes to mediaJobEvents and, for each completed AUDIO job that carries
 * `params.creativeDirectorMusicBed.projectId`, files the rendered track onto
 * that project's `musicBed` field — server-side, independent of any mounted
 * client. This is the project-level counterpart to `catalogImageAttachHook`
 * (#1359): instead of a catalog ingredient, the destination is a Creative
 * Director project record (there is no catalog-attach equivalent for a
 * project-wide music bed — see #1928).
 *
 * The shared completion-hook scaffold (tag-decode, per-project serialization,
 * best-effort error handling, idempotent init/reset) lives in
 * `createMediaJobImageHook` (#1791, generalized to non-image kinds in #1760) —
 * this file is just the music-bed-specific config. Mounted once at server boot
 * from server/index.js (after the media job queue is running).
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { updateProject } from './creativeDirector/local.js';

const hook = createMediaJobImageHook({
  label: 'CD music-bed',
  initLog: '🎼 Creative Director music-bed hook initialized',
  kind: 'audio',
  tagKey: 'creativeDirectorMusicBed',
  identify: (tag) => (typeof tag?.projectId === 'string' && tag.projectId ? { projectId: tag.projectId } : null),
  // Serialize per PROJECT: a project only ever has one music-bed slot, so two
  // completions racing for the same project must not interleave their
  // load→modify→save.
  serializeKey: ({ projectId }) => projectId,
  describe: ({ projectId }) => projectId,
  // generateAudio's `completed` payload (stored as job.result) carries
  // generateMusic's return shape: { filename, durationSec, modelId, model,
  // engine }. `filename` is required to attach; the rest ride along as
  // metadata on the project record.
  extractResult: (job) => {
    const filename = job.result?.filename;
    if (typeof filename !== 'string' || !filename) return null;
    return {
      filename,
      durationSec: Number.isFinite(job.result?.durationSec) ? job.result.durationSec : null,
      engine: typeof job.result?.engine === 'string' ? job.result.engine : null,
      modelId: typeof job.result?.modelId === 'string' ? job.result.modelId : null,
    };
  },
  // The project may have been deleted between enqueue and completion —
  // updateProject throws 404 in that case; treat it the same as the catalog
  // hook's "gone" case (best-effort, never surfaces past the factory's catch).
  attach: ({ projectId, filename, durationSec, engine, modelId }) =>
    updateProject(projectId, {
      musicBed: { filename, durationSec, engine, modelId, generatedAt: new Date().toISOString() },
    }).then(() => 'attached'),
  onAttached: ({ projectId, filename }) => {
    console.log(`🎼 CD project ${projectId.slice(0, 8)} ← music bed ${filename}`);
  },
});

export function initCreativeDirectorMusicBedHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
