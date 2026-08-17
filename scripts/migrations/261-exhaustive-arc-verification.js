/**
 * Make arc verification return one complete defect inventory instead of
 * revealing a fresh sample of latent contradictions after every repair.
 *
 * The convergence gate safely retains finding-keyed exact patches that close
 * their owned targets. That contract depends on the independent verifier being
 * exhaustive: a sampling judge turns real progress into a long waterfall of
 * newly discovered geography, manifest, clock, milestone, and issue-load
 * defects. The shipped prompt now requires a full cross-record reconciliation
 * before it returns.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-verify.md': [
    '83347e7d923580a3062033ab39b3c14b',
    '68f6956d7e09ebdb3870d8726b1b2a7a', // post-261 / pre-263 — before the world category canon block
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-verify.md': 'a397f158fd9c0dca1c8dbe62df253f70', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'exhaustive arc verification',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the exhaustive inventory plus cross-record reconciliation rules.`,
});

export { applyMigration };
export default { up };
