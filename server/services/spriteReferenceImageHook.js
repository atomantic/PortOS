/**
 * Sprite reference candidate attach hook (issue #2896, phase 2).
 *
 * Subscribes to mediaJobEvents and, for each completed image job carrying
 * `params.spriteRef`, copies the rendered file out of the shared gallery into
 * that sprite record's `reference/candidates/` with a generation sidecar —
 * server-side, so a slow cloud render still lands after the user navigated
 * away. Candidates accumulate for review (every render is kept), so unlike
 * the scene hooks there is no newest-wins guard — only per-record
 * serialization so two finishing renders can't race the candidate numbering.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { attachReferenceCandidate } from './sprites/reference.js';

const hook = createMediaJobImageHook({
  label: 'sprite reference-candidate',
  initLog: '🧍 Sprite reference-candidate hook initialized',
  tagKey: 'spriteRef',
  identify: (tag, job) => (tag?.recordId && tag.target && tag.anchorId
    ? {
      recordId: tag.recordId,
      target: tag.target,
      direction: tag.direction,
      anchorId: tag.anchorId,
      chromaKey: tag.chromaKey,
      mode: tag.mode,
      model: tag.model,
      designPrompt: tag.designPrompt,
      jobId: job?.id || null,
    }
    : null),
  serializeKey: ({ recordId }) => recordId,
  describe: ({ recordId, anchorId }) => `${recordId}/${anchorId}`,
  attach: (ctx) => attachReferenceCandidate(ctx),
  onAttached: ({ recordId, anchorId }, result) => {
    console.log(`🧍 sprite reference candidate ${recordId}/${anchorId} ← ${result.candidatePath}`);
  },
});

export function initSpriteReferenceImageHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
