/**
 * Put the screened public-review input in front of one spawning reviewer.
 *
 * `modelAbuseGuard.js` owns the three primitives — materialize the snapshot
 * into a workspace, materialize the read-only patch files, read the snapshot
 * back — and the spawn orchestrator was performing that sequence inline, with
 * the blocked-status write hand-copied twice inside it. This is the sequence,
 * once, returning a verdict the caller's block-and-bail epilogue takes.
 *
 * Its own module rather than a fourth export of `modelAbuseGuard.js` so the
 * suites that already stub those three primitives keep driving the REAL
 * composition: a suite mocking `./modelAbuseGuard.js` wholesale would otherwise
 * replace this logic with a stub and assert nothing about the order.
 */

import {
  materializePublicReviewInput,
  materializePublicReviewPatches,
  readPublicReviewInputSnapshot,
} from './modelAbuseGuard.js';

/**
 * `{ promptData }` once the screened input is in place and readable, or
 * `{ block }` carrying the `{ reason, category, emit }` that refuses the spawn.
 *
 * Fails closed: a snapshot that is missing, unwritable, or unreadable blocks
 * the spawn rather than letting a reviewer start against nothing.
 */
export async function loadPublicReviewSpawnInput({
  scanKey,
  workspacePath,
  actionsStage = false,
  eligibleNumbers = null,
  noToolReviewer = false,
} = {}) {
  // The actions stage is the only one narrowed to specific pull requests; the
  // no-tool gate reads whatever the scan cleared.
  const allowedPullRequestNumbers = actionsStage ? eligibleNumbers : null;
  const materialized = await materializePublicReviewInput({ scanKey, workspacePath, allowedPullRequestNumbers });
  // Only the actions stage may apply a patch, so only it needs the files.
  const patchesMaterialized = !actionsStage
    || await materializePublicReviewPatches({ scanKey, workspacePath, allowedPullRequestNumbers });
  if (!materialized || !patchesMaterialized) {
    return {
      block: {
        reason: 'The screened public-review input snapshot is unavailable or invalid',
        category: 'public-review-input-missing',
        emit: 'agent:error',
      },
    };
  }
  const promptData = await readPublicReviewInputSnapshot({ scanKey, allowedPullRequestNumbers });
  if (!promptData) {
    return {
      block: {
        reason: noToolReviewer
          ? 'The screened public-review input could not be loaded for the no-tools reviewer'
          : 'The screened public-review input could not be loaded for the final reviewer',
        category: 'public-review-input-missing',
        emit: 'agent:error',
      },
    };
  }
  return { promptData };
}
