/** Resolve actionable PLAN.md items before a managed-app dispatch and bind the selected item when the agent does not claim its own. */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { parsePlanItems, extractAllIds, findInProgressIds, pickFirstAvailable, diagnoseUnpickablePlan } from '../../lib/planIds.js';

// Task types where the scheduler reads PLAN.md to find an in-flight-aware pick.
// `do-replan` is excluded — it assigns IDs rather than picking one off the list.
const PLAN_PICK_TASK_TYPES = new Set(['feature-ideas', 'plan-task']);

// Subset of PLAN_PICK_TASK_TYPES where the AGENT picks (and claims) its own slug
// at execution time — mirroring the `/claim` slash command. For these, the
// scheduler must NOT stamp `metadata.planId`: a dispatch-time pre-pick happens
// before the agent creates its `claim/<slug>` branch (the real lock), so two
// near-simultaneous dispatches would both target the same first-available item.
// We still run the in-flight scan below purely as a DISPATCH GATE (skip the run
// when nothing is pickable), but leave the actual pick to the agent's Phase 1
// scan, which immediately precedes branch creation. The 2026-05-21 duplicate-PR
// incident (see cos.test.js) is guarded by the full Phase 1–7 self-pick prompt,
// not by the pre-pick. `feature-ideas` is intentionally NOT in this set — it
// uses a scheduler-managed worktree whose branch name encodes `planId`.
const PLAN_SELF_CLAIM_TASK_TYPES = new Set(['plan-task']);

// Subset of PLAN_PICK_TASK_TYPES where the dispatch should be skipped entirely
// when no PLAN.md item is dispatchable. `feature-ideas` is intentionally
// excluded: it brainstorms new items when PLAN.md is empty/blocked, so it
// must run regardless. `plan-task` is a strict executor and would just exit
// cleanly — burning an LLM round for nothing.
const PLAN_GATE_TASK_TYPES = new Set(['plan-task']);

/**
 * For feature-ideas / plan-task, read the target repo's PLAN.md, find which
 * item IDs are already in flight via branch/PR scan, and pick the first
 * available item. Mutates `metadata` in place by setting `planId` when a
 * pick succeeds — EXCEPT for self-claiming task types (PLAN_SELF_CLAIM_TASK_TYPES),
 * where the agent picks its own slug at execution time and the scan is used
 * only as the dispatch gate (no `planId` stamp).
 *
 * Returns `{ skipReason }` so the caller can short-circuit the LLM dispatch
 * for `plan-task` when there's literally nothing to do (empty plan, all
 * items blocked on human input via NEEDS_INPUT/DRIFT, or all claimed
 * elsewhere). `feature-ideas` is never gated — its job is to brainstorm
 * from scratch when the plan is empty, so it always runs.
 *
 * @returns {Promise<{ skipReason: string | null }>}
 */
export async function applyPlanIdMetadata(taskType, repoPath, metadata) {
  if (!PLAN_PICK_TASK_TYPES.has(taskType)) return { skipReason: null };
  if (!repoPath) return { skipReason: null };
  const planMd = await readFile(join(repoPath, 'PLAN.md'), 'utf-8').catch(() => '');
  const gateDispatch = PLAN_GATE_TASK_TYPES.has(taskType);
  if (!planMd) {
    return { skipReason: gateDispatch ? 'PLAN.md missing or empty' : null };
  }
  const items = parsePlanItems(planMd);

  // Short-circuit on local evidence before the network round-trip to
  // `git fetch --prune` + `gh pr list`. When every unchecked item is
  // already blocked on human input, no in-flight scan can change that.
  if (gateDispatch) {
    const localOnly = diagnoseUnpickablePlan(null, new Set(), items);
    if (localOnly) return { skipReason: localOnly };
  }

  const knownIds = new Set(extractAllIds(planMd));
  const inFlight = await findInProgressIds(repoPath, knownIds).catch(() => new Set());
  const pick = pickFirstAvailable(items, inFlight);
  if (pick?.id) {
    // Self-claiming task types pick their own slug at execution time (like
    // `/claim`); stamping it here would pin concurrent dispatches to the same
    // item. For them this scan only serves as the gate above.
    if (!PLAN_SELF_CLAIM_TASK_TYPES.has(taskType)) {
      metadata.planId = pick.id;
    }
    return { skipReason: null };
  }
  if (!gateDispatch) return { skipReason: null };
  return { skipReason: diagnoseUnpickablePlan(null, inFlight, items) };
}
