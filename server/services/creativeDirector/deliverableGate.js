/**
 * Creative Director — agent-deliverable gate (#4146).
 *
 * A CD `plan` / `treatment` agent's real deliverable is the HTTP PATCH its prompt
 * describes, not its exit code: a non-tool-calling model can exit 0 having PATCHed
 * nothing, and the same model would be re-dispatched forever. Two pure decisions:
 *
 *   1. `deliverableMark` + `deliverableLanded` — a mark stamped at DISPATCH is
 *      compared once the run settles. `plan` carries `replanRounds` because a
 *      bounded RE-plan runs against a project that already has a plan.
 *   2. `countConsecutiveMissedDeliverables` — the empty streak, so the caller stops
 *      re-dispatching and surfaces a blocked stage.
 *
 * Sentinels: `undefined` = no baseline recorded (legacy run), `null` = recorded and
 * absent; collapsing them mis-fails legacy runs or mis-passes empty ones.
 */

import { updateRun } from './local.js';
import { MAX_CONSECUTIVE_MISSED_DELIVERABLES } from '../../lib/creativeDirectorPresets.js';

// Kinds whose deliverable is a verifiable project-record PATCH. `evaluate` is absent:
// its deliverable is a per-scene verdict, reaped by completionHook's orphaned-`evaluating` path.
export const DELIVERABLE_KINDS = new Set(['plan', 'treatment']);

/**
 * A comparable fingerprint of the deliverable `kind` on `project`, or `null` when absent. Pure.
 *
 * @param {object|null} project
 * @param {string} kind — 'plan' | 'treatment'
 * @returns {string|null}
 */
export function deliverableMark(project, kind) {
  if (kind === 'plan') {
    const plan = project?.plan;
    if (!Array.isArray(plan?.steps)) return null;
    // `replanRounds` (bumped by applyPlan on every accepted PATCH) separates a rewrite from a no-op; a timestamp could collide.
    return `plan:${plan.replanRounds ?? 0}`;
  }
  if (kind === 'treatment') {
    const scenes = project?.treatment?.scenes;
    if (!Array.isArray(scenes)) return null;
    return `treatment:${scenes.length}:${project.treatment.logline || ''}${project.workspace === 'video' ? `:${project.treatment.artifact?.revision || 0}` : ''}`;
  }
  return null;
}

/**
 * Did the `kind` deliverable land while this run was in flight? Pure.
 *
 * @param {object|null} project — the project AFTER the run settled.
 * @param {string} kind
 * @param {string|null|undefined} markBefore — mark stamped at dispatch. `undefined`
 *   means no baseline (older build): presence alone counts as landed rather than a false failure.
 */
export function deliverableLanded(project, kind, markBefore) {
  const after = deliverableMark(project, kind);
  if (after === null) return false;
  if (markBefore === undefined) return true;
  // A run from an older version recorded no artifact revision; the suffix added on read is not evidence of a write.
  if (kind === 'treatment' && project.workspace === 'video'
      && markBefore === `treatment:${project.treatment.scenes.length}:${project.treatment.logline || ''}`) return false;
  return after !== markBefore;
}

/**
 * How many of the MOST RECENT runs of `kind` settled without their deliverable.
 * Stops at the first that delivered or belongs to an already-closed streak. Pure.
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
 * completions (to be surfaced, not re-dispatched), else 0. Pure.
 */
export function exhaustedDeliverableStreak(runs, kind) {
  const streak = countConsecutiveMissedDeliverables(runs, kind);
  return streak >= MAX_CONSECUTIVE_MISSED_DELIVERABLES ? streak : 0;
}

/**
 * Stamp the current empty streak CLOSED once the stage is surfaced as blocked, so
 * Resume (e.g. after switching model) gets a fresh budget instead of re-pausing
 * at once; the run ledger keeps `deliverableMissing`. Runs in completion hooks,
 * so it never throws out.
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

/** The user-facing reason on a project parked by the gate; names the remedy. */
export function blockedStageReason(kind, streak) {
  return `The ${kind} agent finished ${streak} time(s) in a row without writing a ${kind}. `
    + `The model assigned to the Creative Director "${kind}" stage is not performing the required PATCH — `
    + 'pick a tool-capable model for that stage, then Resume.';
}

/** The reason stamped on an individual run that exited clean but delivered nothing. */
export function missedDeliverableReason(kind) {
  return `Agent exited cleanly but never wrote the ${kind} (no PATCH landed)`;
}
