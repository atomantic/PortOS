/**
 * Sprite walk-video attach hook (issue #2897, phase 3).
 *
 * Subscribes to mediaJobEvents and, for each completed VIDEO job carrying
 * `params.spriteWalk`, copies the finished grok clip into that run's
 * `grok/<runId>/generated/source-video.mp4` and runs the deterministic
 * postprocess (frame harvest → un-key → cycle select → align → despill →
 * strip/manifest) server-side — a slow cloud render still packages after the
 * user navigated away. Runs accumulate as reviewable candidates (no
 * newest-wins guard); per-record serialization lives in walk.js's write tail.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { attachWalkVideo } from './sprites/walk.js';

const hook = createMediaJobImageHook({
  label: 'sprite walk-video',
  initLog: '🚶 Sprite walk-video hook initialized',
  kind: 'video',
  tagKey: 'spriteWalk',
  // Grok video filenames are always `<jobId>.mp4`; the completed payload
  // echoes it, with the job id as fallback (same contract as the
  // music-video scene hook).
  extractResult: (job) => {
    const filename = (typeof job.result?.filename === 'string' && job.result.filename)
      || (typeof job.id === 'string' ? `${job.id}.mp4` : null);
    return filename ? { filename } : null;
  },
  identify: (tag, job) => (tag?.recordId && tag.direction && tag.runId
    ? { ...tag, jobId: job?.id || null }
    : null),
  serializeKey: ({ recordId }) => recordId,
  describe: ({ recordId, runId }) => `${recordId}/${runId}`,
  attach: attachWalkVideo,
  onAttached: ({ recordId, runId }, result) => {
    console.log(`🚶 sprite walk run ${recordId}/${runId} → ${result?.status || 'attached'}`);
  },
});

export function initSpriteWalkVideoHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
