/**
 * Creative Director — agent-deliverable gate (#4146).
 *
 * A CD `plan` / `treatment` agent's real deliverable is the HTTP PATCH its
 * prompt describes (`PATCH /api/creative-director/:id/plan` or `/treatment`),
 * NOT a commit and NOT its exit code. A non-tool-calling local model can narrate
 * a done-message, signal completion, and exit 0 having PATCHed nothing — the
 * completion hook then marked the run `completed`, the re-dispatch guard in
 * `enqueuePlannerOnce` / `advanceAfterSceneSettled` saw no in-flight run, and the
 * SAME incapable model was handed the SAME task forever. Only boot recovery ever
 * reaped it.
 *
 * This module supplies the two pure decisions that close that loop:
 *
 *   1. `deliverableMark` + `deliverableLanded` — did the PATCH actually land
 *      during this run? A mark is stamped onto the run row at DISPATCH time
 *      (agentBridge) and compared against the project's mark once the run
 *      settles. Presence alone is not enough for `plan`: a bounded RE-plan runs
 *      against a project that already has one, so the mark carries
 *      `replanRounds` (bumped by every accepted PATCH) to tell "the planner
 *      rewrote it" from "the planner did nothing".
 *
 *   2. `countConsecutiveMissedDeliverables` — how many times in a row the stage
 *      has come back empty, so the caller can stop re-dispatching and surface a
 *      blocked stage instead of burning the provider indefinitely.
 *
 * Sentinel discipline (root CLAUDE.md): `undefined` = no baseline recorded (a run
 * enqueued before this change) and `null` = recorded-and-absent are DISTINCT.
 * Collapsing them would either mis-fail every legacy run or mis-pass every empty
 * one.
 */

import { updateRun } from './local.js';
import { MAX_CONSECUTIVE_MISSED_DELIVERABLES } from '../../lib/creativeDirectorPresets.js';

// The CD agent kinds whose deliverable is a project-record PATCH we can verify.
// `evaluate` is deliberately absent: its deliverable is a per-scene verdict, and
// an evaluate run that writes nothing is already reaped by the orphaned-
// `evaluating` scene path in completionHook.
export const DELIVERABLE_KINDS = new Set(['plan', 'treatment']);

/**
 * A comparable fingerprint of the deliverable `kind` on `project`, or `null` when
 * the deliverable is absent. Pure.
 *
 * @param {object|null} project
 * @param {string} kind — 'plan' | 'treatment'
 * @returns {string|null}
 */
export function deliverableMark(project, kind) {
  if (kind === 'plan') {
    const plan = project?.plan;
    if (!Array.isArray(plan?.steps)) return null;
    // `replanRounds` is bumped by applyPlan on EVERY accepted PATCH, so it
    // separates a rewrite from a no-op even when two plans have the same shape
    // (and, unlike a timestamp, can't collide inside one millisecond).
    return `plan:${plan.replanRounds ?? 0}`;
  }
  if (kind === 'treatment') {
    const scenes = project?.treatment?.scenes;
    if (!Array.isArray(scenes)) return null;
    return `treatment:${scenes.length}:${project.treatment.logline || ''}`;
  }
  return null;
}

/**
 * Did the `kind` deliverable land while this run was in flight? Pure.
 *
 * @param {object|null} project — the project AFTER the run settled.
 * @param {string} kind
 * @param {string|null|undefined} markBefore — the mark stamped on the run row at
 *   dispatch. `undefined` means no baseline was recorded (a run enqueued by an
 *   older build); we cannot prove a miss, so presence alone counts as landed
 *   rather than manufacturing a false failure.
 */
export function deliverableLanded(project, kind, markBefore) {
  const after = deliverableMark(project, kind);
  if (after === null) return false;
  if (markBefore === undefined) return true;
  return after !== markBefore;
}

/**
 * How many of the MOST RECENT runs of `kind` settled without their deliverable —
 * the consecutive-empty streak. Walks backwards over runs of that kind and stops
 * at the first one that either delivered or belongs to an already-closed streak.
 * Pure.
 *
 * @param {Array<object>|undefined} runs
 * @param {string} kind
 * @returns {number}
 */
export function countConsecutiveMissedDeliverables(runs, kind) {
  if (!Array.isArray(runs)) return 0;
  let streak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run?.kind !== kind) continue;
    if (run.deliverableMissing !== true || run.deliverableStreakClosed === true) break;
    streak += 1;
  }
  return streak;
}

/**
 * The streak length when the stage has exhausted its budget of consecutive empty
 * completions and must be surfaced to the user instead of re-dispatched, else 0.
 * Pure. Returns the count (not a boolean) so a caller can name the number in the
 * reason it shows the user without walking `runs` a second time.
 */
export function exhaustedDeliverableStreak(runs, kind) {
  const streak = countConsecutiveMissedDeliverables(runs, kind);
  return streak >= MAX_CONSECUTIVE_MISSED_DELIVERABLES ? streak : 0;
}

/**
 * Stamp the current empty streak as CLOSED once the stage has been surfaced as
 * blocked. Without this the streak would still be at the bound the moment the
 * user hits Resume, so the project would re-pause immediately and stay dead even
 * after they switched to a tool-capable model. Closing it hands the next attempt
 * a fresh budget while the run ledger keeps the honest `deliverableMissing`
 * record of what happened.
 *
 * Runs outside the request lifecycle (completion hooks / event bus) — never
 * throws out.
 *
 * @param {string} projectId
 * @param {Array<object>|undefined} runs
 * @param {string} kind
 */
export async function closeDeliverableStreak(projectId, runs, kind) {
  if (!Array.isArray(runs)) return;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run?.kind !== kind) continue;
    if (run.deliverableMissing !== true || run.deliverableStreakClosed === true) break;
    await updateRun(projectId, run.runId, { deliverableStreakClosed: true })
      .catch((e) => console.log(`⚠️ CD close streak on run ${run.runId} of ${projectId} failed: ${e.message}`));
  }
}

/**
 * The user-facing reason shown on a project parked by the gate. Names the stage
 * and the concrete remedy (pick a tool-capable model) rather than a bare
 * "failed", so the CD failure banner is actionable.
 */
export function blockedStageReason(kind, streak) {
  return `The ${kind} agent finished ${streak} time(s) in a row without writing a ${kind}. `
    + `The model assigned to the Creative Director "${kind}" stage is not performing the required PATCH — `
    + 'pick a tool-capable model for that stage, then Resume.';
}

/** The reason stamped on an individual run that exited clean but delivered nothing. */
export function missedDeliverableReason(kind) {
  return `Agent exited cleanly but never wrote the ${kind} (no PATCH landed)`;
}
