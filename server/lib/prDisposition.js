/**
 * `resolveAppPrCompletion(app, metadata)` supplies the reviewed automatic merge default for new tasks
 * while preserving explicit managed-app choices and legacy review toggles.
 */

import { PORTOS_APP_ID } from './appIdentity.js';
import { isFalsyMeta, isTruthyMeta } from './metadataFlags.js';
/**
 * PR disposition for CoS agent tasks: how a pull request completes. The default is that *something* lands it (the review-loop follow-up when a Review Loop is configured, otherwise a merge
 * follow-up or the agent's own completion workflow on green CI); a PR nobody merges is a leaked branch.
 *
 * The exception is a task that hands its PR to a human AND records that hand-off where PortOS can't update it (`jira-sprint-manager` moves the ticket to "In Review"; merging behind the board's
 * back would leave it in review forever). Lives in `lib/` because both the prompt builder (agent merges) and worktree cleanup (a follow-up agent merges) need it; one consulting half would split-brain.
 */

export const PR_COMPLETIONS = Object.freeze({
  REVIEW_THEN_MERGE: 'review-then-merge',
  MERGE_ON_GREEN: 'merge-on-green',
  LEAVE_OPEN: 'leave-open',
  // A creation contract; lifecycle consumers resolve it to LEAVE_OPEN.
  DRAFT: 'draft',
});

export const PR_COMPLETION_VALUES = Object.freeze(Object.values(PR_COMPLETIONS));

const PR_COMPLETION_SET = new Set(PR_COMPLETION_VALUES);

// New PR tasks default to PortOS-coordinated review and automatic merge; stored task records keep their legacy resolution and app defaults never rewrite a run's pinned policy.
// GitHub native auto-merge is the separate `useAutoMerge` choice (resolveUseAutoMerge).
export const DEFAULT_PR_COMPLETION = PR_COMPLETIONS.REVIEW_THEN_MERGE;

export function resolveAppPrCompletion(app, metadata = {}) {
  if (PR_COMPLETION_SET.has(app?.defaultPrCompletion)) return app.defaultPrCompletion;
  // An explicit legacy review toggle keeps its behavior; only missing settings get the new default.
  if ([true, false, 'true', 'false'].includes(metadata?.reviewLoop)) return resolvePrCompletion(metadata);
  return DEFAULT_PR_COMPLETION;
}

/** Whether an agent that merges its own PR should enable GitHub native auto-merge once review passes. Task choice wins, then the app's `useAutoMerge`; unset defaults ON only for PortOS itself. */
export function resolveUseAutoMerge(app, metadata = {}) {
  if (isTruthyMeta(metadata?.useAutoMerge)) return true;
  if (isFalsyMeta(metadata?.useAutoMerge)) return false;
  if (typeof app?.useAutoMerge === 'boolean') return app.useAutoMerge;
  return app?.id === PORTOS_APP_ID;
}

// Code-owner-blocked PRs: both choices are opt-in with NO per-app default (unlike `useAutoMerge`, PortOS itself is off too),
// because one overrides a repository review rule and the other bypasses branch protection. Task choice wins, then the app's value.
const resolveOptIn = (key) => (app, metadata = {}) => {
  if (isTruthyMeta(metadata?.[key])) return true;
  if (isFalsyMeta(metadata?.[key])) return false;
  return app?.[key] === true;
};

/** Whether the agent should approve its own PR (`gh pr review --approve`) when a required code-owner review blocks the merge. */
export const resolveAutoApprovePR = resolveOptIn('autoApprovePR');

/** Whether the agent may merge with `gh pr merge --admin` once required CI is green on the pinned head and only a review requirement blocks it. */
export const resolveAdminMerge = resolveOptIn('adminMerge');

/**
 * WHO performs the code review an action triggers, orthogonal to `PR_COMPLETIONS` (whether a review happens at all).
 * - `delegated`: the agent is an ORCHESTRATOR that spawns the Code Review Defaults roster (or a per-run override) as separate reviewer processes and applies their findings.
 * - `self`: the action's own provider reviews the change and no reviewer CLI is spawned (cheaper; right when the top-level provider is the model you wanted).
 * A mode rather than "an empty roster": an empty roster already means *no review* (`spawnReviewLoopFollowUp`'s merge-only path), and the two must stay distinguishable downstream.
 * This module imports nothing, so the client mirrors the vocabulary by importing it.
 */
export const PR_REVIEW_MODES = Object.freeze({
  DELEGATED: 'delegated',
  SELF: 'self',
});

export const PR_REVIEW_MODE_VALUES = Object.freeze(Object.values(PR_REVIEW_MODES));

/** What an action runs under when the caller names no mode. */
export const DEFAULT_PR_REVIEW_MODE = PR_REVIEW_MODES.DELEGATED;

/** True when this run's review is the running agent's own job; a predicate so callers never compare against the `'self'` literal (it would drift when a third mode appears). */
export const isSelfReviewMode = (mode) => mode === PR_REVIEW_MODES.SELF;

/**
 * Resolve a task's PR completion policy without migrating stored data: new tasks persist `prCompletion`; legacy records resolve their `reviewLoop` bit to the behavior they always had.
 * `openPR` stays the separate decision of whether to create a PR at all.
 *
 * @param {Object|null|undefined} metadata
 */
export function resolvePrCompletion(metadata = {}) {
  if (metadata?.prCompletion === PR_COMPLETIONS.DRAFT) return PR_COMPLETIONS.LEAVE_OPEN;
  if (PR_COMPLETION_SET.has(metadata?.prCompletion)) return metadata.prCompletion;
  return isTruthyMeta(metadata?.reviewLoop)
    ? PR_COMPLETIONS.REVIEW_THEN_MERGE
    : PR_COMPLETIONS.MERGE_ON_GREEN;
}

/** Scheduled task types whose prompt hands the PR to a human. Keep tiny: every entry is a PR a person must remember to merge. */
export const PR_STAYS_OPEN_TASK_TYPES = Object.freeze(['jira-sprint-manager']);

const PR_STAYS_OPEN_SET = new Set(PR_STAYS_OPEN_TASK_TYPES);

/**
 * True when a task's PR must be left open for a human: an exempt task type, or any task carrying a JIRA ticket (the ticket status is the hand-off). Reviewers still run; this governs the *merge*.
 *
 * @param {Object|null} task - the CoS task (or its metadata holder).
 */
export function leavesPrForHuman(task) {
  const metadata = task?.metadata || {};
  return PR_STAYS_OPEN_SET.has(metadata.analysisType) || !!metadata.jiraTicketId;
}

/**
 * True when the PR stays open for either reason: a human lands it (`leavesPrForHuman`) or the resolved policy is leave-open (draft included).
 *
 * @param {Object|null} task - the CoS task (or its metadata holder).
 */
export function prStaysOpen(task) {
  return resolvePrCompletion(task?.metadata) === PR_COMPLETIONS.LEAVE_OPEN || leavesPrForHuman(task);
}

/**
 * True when an operator hold keeps every automated path (merge, handoff, recovery,
 * cleanup review) off this task's PR: `prStaysOpen`, a read-only task, or a review
 * loop told to leave the PR open. Add a new hold signal here, never at a guard.
 *
 * @param {Object|null} task - the CoS task (or its metadata holder).
 */
export function prHeldForOperator(task) {
  return prStaysOpen(task) || isTruthyMeta(task?.metadata?.readOnly) || isTruthyMeta(task?.metadata?.reviewLoopLeaveOpen);
}

/** `prHeldForOperator`, plus the leave-open policy an agent pinned at spawn. */
export function agentPrHeldForOperator(agent, task) {
  return agent?.metadata?.prCompletionPolicy === PR_COMPLETIONS.LEAVE_OPEN || prHeldForOperator(task);
}

/** Explicit task authority only: defaults must never release a human handoff. */
export function explicitPrCompletion(task) {
  const metadata = task?.metadata || {};
  if (leavesPrForHuman(task) || isTruthyMeta(metadata.reviewLoopLeaveOpen)) return PR_COMPLETIONS.LEAVE_OPEN;
  return PR_COMPLETION_SET.has(metadata.prCompletion) ? resolvePrCompletion(metadata) : null;
}

// Shared by the PR-claim producer and cleanup classifier.
export const PR_MISSING_CATEGORY = 'pr-missing';

/**
 * Who opens the change request for a completing worktree agent (#3733). One tri-state, since two booleans have an unrepresentable pair ("check first, but never create").
 * - `NEVER`: the agent owns it and finalize ALREADY verified the claim (`prExpected`); also the no-PR case.
 * - `IF_MISSING`: the agent owns it and finalize did NOT verify (slashdo-free harness); cleanup asks the forge once and creates only on a definite "none".
 * - `ALWAYS`: PortOS owns it (a lean `--bare` session hands the lifecycle back).
 */
export const PR_CREATION = Object.freeze({
  NEVER: 'never',
  IF_MISSING: 'if-missing',
  ALWAYS: 'always',
});

/**
 * Resolve `PR_CREATION` for a completing agent, in one place so the three completion paths (runner, TUI spawner, direct-CLI spawner) can't double-fire `gh pr create` or leave a branch with no PR.
 *
 * @param {Object} opts
 * @param {boolean} opts.taskOpenPR - the task asked for a PR at all
 * @param {boolean} opts.agentOpensOwnPr - the prompt told the agent to open it
 * @param {boolean} opts.prClaimVerified - finalize ran `verifyPrClaim` for this
 *   run (i.e. `prExpected` was true), so cleanup must not ask a second time
 * @param {boolean} [opts.branchProvenEmpty] - finalize verified an opted-in audit
 *   left no commits and no change request, so cleanup must not create an empty PR
 * @returns {string} a `PR_CREATION` value
 */
export function resolvePrCreation({ taskOpenPR, agentOpensOwnPr, prClaimVerified, branchProvenEmpty = false }) {
  if (!taskOpenPR || branchProvenEmpty) return PR_CREATION.NEVER;
  if (!agentOpensOwnPr) return PR_CREATION.ALWAYS;
  return prClaimVerified ? PR_CREATION.NEVER : PR_CREATION.IF_MISSING;
}

/**
 * Did a `verifyPrClaim` result actually come from the forge about a real branch? `{ ok: true }` alone does NOT mean a PR exists: it is also returned when there was nothing to verify
 * (`prExpected` false, failed run, no workspace), when the branch had no name (detached HEAD), and as the callers' substitute when the check threw or the run was terminated.
 * Collapsing "we did not ask" into "it's there" gets a branch with no PR cleaned up as if it had one, so a verified verdict requires BOTH `ok` and a named `branch`
 * (only the `found` and `branchProvenEmpty` shapes carry it).
 *
 * @param {{ok?: boolean, branch?: string|null}|null|undefined} prVerdict
 * @returns {boolean}
 */
export function prClaimWasVerified(prVerdict) {
  return prVerdict?.ok === true && !!prVerdict.branch;
}
