/**
 * CoS Task Challenge — bounded worker↔reviewer dispute protocol (#2441)
 *
 * When a review-loop reviewer REJECTS a sub-agent's work, the agent's only prior
 * outcomes were "silently fix whatever was flagged" or "get blocked" — a wrong
 * rejection (common with noisy local/CLI reviewers) burned budget on an unneeded
 * fix or false-blocked good work. This module is the safety primitive for the
 * alternative: a worker may DISPUTE a rejection exactly once per task, parking it
 * in the `challenged` status with its full case attached, and the dispute either
 * resolves back to work (`upheld`) or escalates to the single PortOS user
 * (`escalated`) — never an unbounded fix/challenge loop.
 *
 * Bounded by design (Conductor's challenge protocol shares the retry budget so an
 * agent can't loop forever disputing): `MAX_CHALLENGES_PER_TASK` caps disputes at
 * one; `canChallenge` refuses a second. Single-user trust model — "escalate to the
 * user" = surface a decision to the one operator, not multi-actor arbitration.
 *
 * Pure + side-effect-free (mirrors cosTaskClaim.js): every function operates on a
 * plain task-metadata object and returns a partial-metadata patch to merge via
 * `cosTaskStore.updateTask`, a boolean, or a number. Persistence, the status
 * transition, and the escalation task live in the caller (cosTaskStore.js).
 *
 * The challenge record round-trips the TASKS.md markdown store like any other
 * metadata (objects/numbers via the JSON sentinel — see taskParser.js), and is
 * part of the merge's content signature, so a challenge federates + converges
 * across peers with no bespoke wire field (#1712 cosTasks federation).
 */

// One dispute per task. Sized as a hard cap (not a knob) so the acceptance
// contract — "a worker can dispute exactly one rejection per task; further
// disputes are refused" — is enforced in one place.
export const MAX_CHALLENGES_PER_TASK = 1;

// Resolution outcomes. `upheld` overturns the rejection (work re-queues);
// `escalated` hands an unresolved/failed dispute to the user rather than
// silently fixing or blocking. Mirrored by the route enum in cosValidation.js
// (`resolveChallengeSchema`) — a parity test keeps the two in lockstep.
export const CHALLENGE_OUTCOMES = Object.freeze(['upheld', 'escalated']);

// The metadata keys this module owns on a task. Exported so callers/tests can
// reason about (or strip) the challenge trio in one place.
export const CHALLENGE_METADATA_KEYS = Object.freeze(['challengeCount', 'challenge', 'challengeResolution']);

/**
 * How many challenges a task has already consumed. Coerces the value defensively:
 * after a TASKS.md round-trip the number arrives as the string `"1"`, so parse it
 * and treat anything non-positive/unparseable as 0 ("never challenged").
 */
export function getChallengeCount(metadata) {
  const raw = metadata?.challengeCount;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * May this task still be challenged? True until the per-task cap is reached.
 */
export function canChallenge(metadata, { max = MAX_CHALLENGES_PER_TASK } = {}) {
  return getChallengeCount(metadata) < max;
}

/**
 * Build the metadata patch that RECORDS a worker's dispute and consumes a
 * challenge slot. Increments `challengeCount`, stores the worker's case under
 * `challenge` ({ reason, evidence?, reviewer?, challengedAt }), and clears any
 * prior `challengeResolution` (undefined → updateTask strips it) so a re-dispute
 * doesn't carry a stale verdict. Merge over the task's existing metadata.
 *
 * The caller is responsible for the `canChallenge` guard + the `challenged`
 * status transition; this only shapes the metadata.
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
    // A fresh dispute is unresolved — drop any prior verdict.
    challengeResolution: undefined,
  };
}

/**
 * Build the metadata patch that RESOLVES a dispute. Returns null for an unknown
 * outcome so the caller can reject it. `challengeResolution` records the verdict
 * ({ outcome, resolvedAt, note?, resolvedBy? }); the caller maps the outcome to
 * the next task status (`upheld` → pending, `escalated` → blocked + user surface).
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
