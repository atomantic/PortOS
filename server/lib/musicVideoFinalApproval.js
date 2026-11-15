/**
 * Music Video per-shot approval to upgrade a draft clip to final resolution (#16136).
 *
 * A director approves a shot's selected draft take for a final render. The approval stores the take
 * and a revision of what the clip was made from (shot prompt, start frame, end frame), so it is
 * derived valid at read time: a later prompt, reference or selection change simply stops matching,
 * with no invalidation hook to forget. Dependency-free; the client imports it.
 */

import { authoredShotPrompt } from './musicVideoShotPrompt.js';

// FNV-1a: a short stable fingerprint, not a security boundary.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** What the shot's clip is made from: its prompt and start/end frames. */
export const sceneRenderRevision = (scene) => fingerprint(JSON.stringify([
  authoredShotPrompt(scene) || '', scene?.referenceImageId || null, scene?.endImageId || null,
]));

/** The shot's selected clip take, or null. */
export const selectedVideoTake = (scene) => (scene?.videoHistoryId
  ? (scene.takes || []).find((take) => take?.kind === 'video' && take.assetId === scene.videoHistoryId) || null
  : null);

/** Whether the shot's approval still matches its selected take and its revision. */
export function sceneFinalApproved(scene) {
  const approval = scene?.finalApproval;
  const take = selectedVideoTake(scene);
  return Boolean(approval && take && approval.takeId === take.takeId && approval.revision === sceneRenderRevision(scene));
}

/**
 * The scene patch that approves (`approved` true) or clears the shot's approval,
 * or `{ problem }` when there is no selected clip to approve.
 */
export function finalApprovalPatch(scene, approved) {
  if (!approved) return { patch: { finalApproval: null } };
  const take = selectedVideoTake(scene);
  if (!take) return { problem: 'Select a clip take before approving this shot for final' };
  return { patch: { finalApproval: { takeId: take.takeId, revision: sceneRenderRevision(scene) } } };
}

/** Whether the selected clip was rendered at the final tier. */
export const sceneClipIsFinal = (scene) => selectedVideoTake(scene)?.tier === 'final';

/**
 * Draft/approved/final counts over the shots that have a selected clip. `draft`
 * counts clips not yet at the final tier; `approved` the valid approvals still
 * waiting to be upgraded; `missing` shots with no clip.
 */
export function finalTierCounts(scenes) {
  const counts = { draft: 0, approved: 0, final: 0, missing: 0 };
  for (const scene of scenes || []) {
    if (!selectedVideoTake(scene)) counts.missing += 1;
    else if (sceneClipIsFinal(scene)) counts.final += 1;
    else {
      counts.draft += 1;
      if (sceneFinalApproved(scene)) counts.approved += 1;
    }
  }
  return counts;
}

