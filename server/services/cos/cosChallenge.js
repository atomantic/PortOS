/**
 * CoS Task Challenge: bounded worker-reviewer dispute protocol (#2441).
 *
 * A worker may DISPUTE a review-loop rejection exactly once per task, parking it in `challenged` status with
 * its case attached; it resolves back to work (`upheld`) or escalates to the single PortOS user (`escalated`),
 * never an unbounded fix/challenge loop. `canChallenge` refuses a second dispute and shares the retry budget.
 *
 * Pure + side-effect-free (like cosTaskClaim.js): functions take a plain task-metadata object and return a
 * patch to merge via `cosTaskStore.updateTask`, a boolean, or a number. Persistence, the status transition and
 * the escalation task live in cosTaskStore.js.
 *
 * The challenge record is kept as nested metadata by the stored form (lib/cos/cosTaskRows.js) and is part of the
 * merge's content signature, so it federates across peers with no bespoke wire field (#1712).
 */

import { REVIEW_FINDING_HEADINGS, REVIEW_FINDING_HEADING_SUFFIX } from '../../lib/codeReviewVerdict.js';

const RECHECK_FINDING_HEADINGS = new Set([
  ...Object.values(REVIEW_FINDING_HEADINGS).flatMap(heading => [
    heading.toLowerCase(),
    `${heading}${REVIEW_FINDING_HEADING_SUFFIX}`.toLowerCase(),
  ]),
  'blocking',
]);

// Hard cap, not a knob: one dispute per task, enforced in one place.
export const MAX_CHALLENGES_PER_TASK = 1;

// `upheld` overturns the rejection (work re-queues); `escalated` hands the dispute to the user.
// Mirrored by `resolveChallengeSchema` in cosValidation.js; a parity test keeps them in lockstep.
export const CHALLENGE_OUTCOMES = Object.freeze(['upheld', 'escalated']);

/**
 * How many challenges a task has consumed: a number, or its string (`"1"`) on rows stored before #16407 and peers on older versions, so parse it and treat non-positive/unparseable as 0.
 */
export function getChallengeCount(metadata) {
  const raw = metadata?.challengeCount;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * May this task still be challenged? Bounded by the one-shot per-task cap AND, when `maxTotalSpawns` is
 * supplied (the shared `MAX_TOTAL_SPAWNS`), the shared retry budget (#2471): a successful challenge re-queues
 * the task, which agentLifecycle's spawn-cap gate would just re-block once the budget is spent.
 * Omitted, only the cap applies, keeping this module pure and import-free.
 */
export function canChallenge(metadata, { max = MAX_CHALLENGES_PER_TASK, maxTotalSpawns } = {}) {
  if (getChallengeCount(metadata) >= max) return false;
  if (maxTotalSpawns != null) {
    const spawns = Number(metadata?.totalSpawnCount) || 0;
    if (spawns >= maxTotalSpawns) return false;
  }
  return true;
}

/**
 * Build the metadata patch that RECORDS a worker's dispute and consumes a challenge slot. Clears any prior
 * `challengeResolution` (undefined -> updateTask strips it) so a re-dispute carries no stale verdict.
 * The caller owns the `canChallenge` guard and the `challenged` status transition.
 */
export function buildChallengePatch(metadata, { reason, evidence, reviewer, now = Date.now() } = {}) {
  const challenge = {
    reason: String(reason ?? '').trim(),
    challengedAt: new Date(now).toISOString(),
  };
  if (typeof evidence === 'string' && evidence.trim()) challenge.evidence = evidence.trim();
  if (typeof reviewer === 'string' && reviewer.trim()) challenge.reviewer = reviewer.trim();
  return {
    challengeCount: getChallengeCount(metadata) + 1,
    challenge,
    // A fresh dispute is unresolved: drop any prior verdict.
    challengeResolution: undefined,
  };
}

/**
 * Build the metadata patch that RESOLVES a dispute; `null` for an unknown outcome so the caller can reject it.
 * The caller maps the outcome to the next status (`upheld` -> pending, `escalated` -> blocked + user surface).
 */
export function buildChallengeResolutionPatch({ outcome, note, resolvedBy, now = Date.now() } = {}) {
  if (!CHALLENGE_OUTCOMES.includes(outcome)) return null;
  const resolution = {
    outcome,
    resolvedAt: new Date(now).toISOString(),
  };
  if (typeof note === 'string' && note.trim()) resolution.note = note.trim();
  if (typeof resolvedBy === 'string' && resolvedBy.trim()) resolution.resolvedBy = resolvedBy.trim();
  return { challengeResolution: resolution };
}

/**
 * A clean re-check overturns the rejection. Any finding that still requires
 * resolution sends the dispute to the operator. Unusable replies leave it open.
 */
export function classifyRecheckOutcome(findings) {
  if (typeof findings !== 'string') return null;
  const trimmed = findings.trim();
  if (/^no findings\.?$/i.test(trimmed)) return 'upheld';

  let inFindingSection = false;
  let hasFindingHeading = false;
  for (const line of trimmed.split(/\r?\n/)) {
    const heading = /^[ \t]*#{1,6}[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      inFindingSection = RECHECK_FINDING_HEADINGS.has(heading[1].toLowerCase());
      hasFindingHeading ||= inFindingSection;
    } else if (inFindingSection && line.trim()) {
      return 'escalated';
    }
  }
  return hasFindingHeading ? 'upheld' : null;
}
