/**
 * PR disposition for CoS agent tasks — how a pull request completes.
 *
 * The default is that *something* lands it: the review-loop follow-up when a
 * Review Loop is configured, a merge follow-up (or the agent's own completion
 * workflow) on green CI when it isn't. A PR nobody merges is a leaked branch.
 *
 * The exception is a task that deliberately hands its PR to a human AND records
 * that hand-off somewhere PortOS can't update afterwards. `jira-sprint-manager`
 * is the case that exists today: its prompt transitions the ticket to "In
 * Review", so merging the PR behind the board's back would leave the work merged
 * and the ticket permanently in review — and nothing in the completion path
 * knows the ticket key to transition it to Done.
 *
 * This lives in `lib/` because both halves of the decision need it: the prompt
 * builder (agent-owned PR flows, where the agent merges) and the worktree
 * cleanup (PortOS-owned PR flows, where a follow-up agent merges). A predicate
 * that only one half consults produces exactly the split-brain it's meant to
 * prevent.
 */

export const PR_COMPLETIONS = Object.freeze({
  REVIEW_THEN_MERGE: 'review-then-merge',
  MERGE_ON_GREEN: 'merge-on-green',
  LEAVE_OPEN: 'leave-open',
});

export const PR_COMPLETION_VALUES = Object.freeze(Object.values(PR_COMPLETIONS));

const PR_COMPLETION_SET = new Set(PR_COMPLETION_VALUES);

/**
 * Resolve a task's PR completion policy without migrating stored task data.
 *
 * New tasks persist `prCompletion`; legacy records retain their `reviewLoop`
 * bit and resolve to the same behavior they had before this field existed.
 * `openPR` remains the separate decision of whether to create a PR at all.
 *
 * @param {Object|null|undefined} metadata
 * @returns {'review-then-merge'|'merge-on-green'|'leave-open'}
 */
export function resolvePrCompletion(metadata = {}) {
  if (PR_COMPLETION_SET.has(metadata?.prCompletion)) return metadata.prCompletion;
  return metadata?.reviewLoop === true || metadata?.reviewLoop === 'true'
    ? PR_COMPLETIONS.REVIEW_THEN_MERGE
    : PR_COMPLETIONS.MERGE_ON_GREEN;
}

/**
 * Scheduled task types whose prompt hands the PR to a human. Keep this tiny —
 * every entry is a PR a person must remember to merge.
 */
export const PR_STAYS_OPEN_TASK_TYPES = Object.freeze(['jira-sprint-manager']);

const PR_STAYS_OPEN_SET = new Set(PR_STAYS_OPEN_TASK_TYPES);

/**
 * True when a task's PR must be left open for a human rather than merged: an
 * exempt task type, or any task carrying a JIRA ticket (the ticket status is the
 * hand-off, and no completion path here can transition it).
 *
 * Reviewers still run when configured — this governs the *merge*, not the review.
 *
 * @param {Object|null} task - the CoS task (or its metadata holder).
 * @returns {boolean}
 */
export function leavesPrForHuman(task) {
  const metadata = task?.metadata || {};
  return PR_STAYS_OPEN_SET.has(metadata.analysisType) || !!metadata.jiraTicketId;
}

/**
 * Who opens the change request for a completing worktree agent (#3733).
 *
 * One tri-state rather than two booleans, because two booleans have an
 * unrepresentable-in-practice pair ("check first, but never create") and a
 * caller has to keep them consistent by hand.
 *
 * - `NEVER`    — the agent owns it and finalize ALREADY verified the claim
 *                (`prExpected`), so a run that reaches cleanup as a success has
 *                a confirmed PR. Also the no-PR-at-all case.
 * - `IF_MISSING` — the agent owns it and finalize did NOT verify (a slashdo-free
 *                harness). Cleanup asks the forge once and creates one only on a
 *                definite "none".
 * - `ALWAYS`   — PortOS owns it (a lean `--bare` session hands the lifecycle back).
 */
export const PR_CREATION = Object.freeze({
  NEVER: 'never',
  IF_MISSING: 'if-missing',
  ALWAYS: 'always',
});

/**
 * Resolve `PR_CREATION` for a completing agent — one place, so the three
 * completion paths (runner, TUI spawner, direct-CLI spawner) can't drift into
 * double-firing `gh pr create` or into leaving a branch with no PR.
 *
 * @param {Object} opts
 * @param {boolean} opts.taskOpenPR - the task asked for a PR at all
 * @param {boolean} opts.agentOwnsPr - the prompt told the agent to open it
 * @param {boolean} opts.prClaimVerified - finalize ran `verifyPrClaim` for this
 *   run (i.e. `prExpected` was true), so cleanup must not ask a second time
 * @param {boolean} [opts.noChangesToShip] - finalize verified an opted-in audit
 *   left no commits and no change request, so cleanup must not create an empty PR
 * @returns {string} a `PR_CREATION` value
 */
export function resolvePrCreation({ taskOpenPR, agentOwnsPr, prClaimVerified, noChangesToShip = false }) {
  if (!taskOpenPR || noChangesToShip) return PR_CREATION.NEVER;
  if (!agentOwnsPr) return PR_CREATION.ALWAYS;
  return prClaimVerified ? PR_CREATION.NEVER : PR_CREATION.IF_MISSING;
}

/**
 * Did a `verifyPrClaim` result actually come from the forge about a real branch?
 *
 * `{ ok: true }` alone does NOT mean "a PR exists" — it is also what the
 * function returns when there was nothing to verify (`prExpected` false, a
 * failed run, no workspace), when the branch could not be named (detached
 * HEAD → `{ ok: true, branch: null }`), and what the callers substitute when
 * the check itself threw or the run was user-terminated. Every one of those is
 * "we did not ask", and collapsing them into "asked and it's there" is how a
 * branch with no PR gets cleaned up as if it had one.
 *
 * A verified verdict therefore requires BOTH `ok` and a named `branch` — which
 * only the `found` and `noChangesToShip` shapes carry.
 *
 * @param {{ok?: boolean, branch?: string|null}|null|undefined} prVerdict
 * @returns {boolean}
 */
export function prClaimWasVerified(prVerdict) {
  return prVerdict?.ok === true && !!prVerdict.branch;
}
