/**
 * Agent Finalization
 *
 * The shared end-of-run path for ALL three spawn modes (runner-mode
 * `handleAgentCompletion`, the TUI `finish()` handler, and the direct-CLI
 * `close` handler): lane release + execution tracking, success-criteria
 * evaluation, the programmatic-I/O output hook, and the centralized state
 * writes (`completeAgent` / `updateTask` / run tracking).
 *
 * Extracted from `agentLifecycle.js` (issue #2837) to break the static import
 * cycle it sat in the middle of: `agentCliSpawning.js` and
 * `agentTuiSpawning.js` both need `finalizeAgent` / `releaseAgentLane`, while
 * `agentLifecycle.js` imports BOTH spawners. This module is a leaf with
 * respect to that cluster — it must NOT import `agentLifecycle.js`,
 * `agentCliSpawning.js`, `agentTuiSpawning.js`, or `agentManagement.js`, or the
 * cycle comes straight back. `server/services/agentImportCycles.test.js`
 * enforces that.
 */

import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { cosEvents, emitLog } from './cosEvents.js';
// The DEFINING module, not a barrel (#3450) — see the note in
// `agentManagement.js`. This module is a LEAF that both transition modules
// import, which puts it inside the facade's closure, so the facade is out of
// reach here.
import { getAgent, getAgentRecord, updateAgent, completeAgent } from './cosAgentLifecycle.js';
import { updateTask } from './cos.js';
import { getActiveProvider } from './providers.js';
import { markProviderUsageLimit, markProviderUnavailable } from './providerStatus.js';
import { resolveProviderBench } from '../lib/providerCooldown.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { resolveFailedTaskUpdate, resolveTypeFailureSignal } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, runWindowDiff } from '../lib/gitCommitProbe.js';
import {
  GOAL_FIDELITY_CATEGORY,
  GOAL_FIDELITY_HOLD_EVENT,
  MAX_FIDELITY_DIFF_CHARS,
  formatGoalFidelitySummary,
  goalFidelityHoldsRun,
  taskObjective,
} from '../lib/goalFidelity.js';
import { getGoalFidelityConfig, runLocalGoalFidelityReview } from './codeReview.js';
import { SKIP_LEARNING_VERDICT } from '../lib/learningVerdict.js';
import { detectPrimaryCheckoutDrift, PRIMARY_CHECKOUT_MUTATED_ESCALATION, PRIMARY_CHECKOUT_MUTATED_REASON } from '../lib/primaryCheckoutGuard.js';
import { canRunTaskOutputHookWithoutPayload, getTaskOutputPayloadPredicate, isProgrammaticIoTaskType, resolveTaskHookType, declaresNoCommitCriterion } from './taskTypeHooks.js';
import { processAgentCompletion } from './agentCompletion.js';
import { extractSimplifySummaries } from './agentSummaryExtraction.js';
import { usesCreativeDirectorScratchCwd, removeCreativeDirectorScratchCwd } from '../lib/spawnCwd.js';
import { issueNumberFromRef } from './issueReconcile.js';

/**
 * Release the execution lane and complete tool-execution tracking for a
 * finishing agent. Pulled OUT of finalizeAgent so callers can fire it
 * EARLY (before reading output.txt, running error analysis, or writing
 * state) — neither call blocks on I/O, but lanes serialize related work
 * and we don't want them held longer than necessary.
 *
 * Idempotent enough to be a no-op when laneName / executionId are absent
 * (recovered agents post-restart, error paths that already released).
 */
export function releaseAgentLane({ agentId, success, duration, exitCode, executionId, laneName, errorExecutionMessage }) {
  if (laneName) release(agentId);
  if (!executionId) return;
  if (success) {
    completeExecution(executionId, { success: true, duration });
  } else {
    errorExecution(executionId, { message: errorExecutionMessage || `Agent exited with code ${exitCode}`, code: exitCode });
    completeExecution(executionId, { success: false });
  }
}

/**
 * Evaluate a completed autonomous run against its DECLARED success criteria
 * (issue #2344). Distinct from the runner's exit-code `success`: it answers
 * "did the run actually produce the work it was supposed to?" using the one
 * machine-checkable criterion the CoS can actually observe — did the run leave
 * a commit behind inside its own run window (`committedDuringRun`)?
 *
 * That probe replaced a task-id commit-marker grep in #3637. NOTHING ever
 * emitted that marker — no prompt, template, or slashdo command asked an agent
 * to stamp a task id into a commit subject, and the root AGENTS.md forbids
 * exactly that shape of subject line — so the criterion was unsatisfiable and
 * stamped `validationPassed: false` on every ordinary code-editing run,
 * poisoning the task-learning buckets it feeds.
 *
 * Returns a null sentinel when NO criterion is declared (interactive/user tasks,
 * user-terminated runs, or a run with no task id / workspace / run window to
 * validate against), so downstream telemetry never conflates "not declared" with
 * "declared and failed". For autonomous tasks it verifies the commit on BOTH
 * success and failure — a clean exit that committed nothing is an honest miss,
 * and that is exactly the signal task-learning wants. `committedDuringRun` is
 * non-throwing and hard-timeout-bounded, so a non-repo workspace or a hung git
 * degrades to "no commit" rather than stalling finalize.
 *
 * `startedAt` (epoch ms) bounds the window. A non-finite value means we can't
 * tell this run's commits from anything already in the repo, so the criterion is
 * undeclared (null) rather than a manufactured `false`.
 *
 * `hookResult` is the programmatic-I/O output-hook result (from
 * `dispatchTaskOutputHook`), which finalizeAgent resolves BEFORE calling this so
 * those task types can be judged by their real deliverable; `success` is the
 * runner's exit-code verdict that hook result is weighed against. Both are
 * absent/null for every other task shape.
 *
 * That branch is also the only one that can return `SKIP_LEARNING_VERDICT` — the
 * third answer, meaning "nothing evaluated this run, so don't record it at all"
 * (#4107). It rides `result.validationPassed` like the boolean/null verdicts and
 * is consumed by `buildTaskTelemetryContext`; see `lib/learningVerdict.js`.
 *
 * @returns {Promise<boolean|null|'skip-learning'>}
 */
export async function evaluateSuccessCriteria({ task, terminatedByUser, workspacePath, startedAt = null, success = false, hookResult = null, noChangesToShip = false, noChangeProof = null }) {
  if (terminatedByUser) return null;
  const taskType = task?.taskType || 'user';
  // The SCHEDULED type (`metadata.analysisType`) if any, else the queue category —
  // the same resolution the programmatic-I/O gate uses, reused for the coordinator
  // gate below so both key on the task's real type, not the CoS bucket ('internal').
  const scheduledType = resolveTaskHookType(task);
  // Programmatic-I/O tasks (taskTypeHooks.js) declare their OWN criterion — the
  // sentinel parsed and the hook accepted it — so this branch comes FIRST: it is
  // keyed on the hook result rather than on a workspace/commit, and must not be
  // pre-empted by the `!workspacePath` bail below (a hook that already ran and
  // threw is a real verdict even if the worktree is gone). Their prompts
  // explicitly FORBID committing or opening a PR (the worktree is discarded), so
  // the commit criterion would mark every correct run a failure (#2700).
  // Judging them purely by exit code instead is also wrong: an exit-0 run whose
  // `.agent-done` sentinel was missing/malformed, or whose hook threw, produced
  // nothing usable and must be recorded as the failure it is (#2727).
  if (isProgrammaticIoTaskType(scheduledType)) {
    return resolveProgrammaticIoVerdict({ success, hookResult });
  }
  // Interactive/user tasks declare no machine-checkable criterion; neither does
  // a run missing the task id or workspace needed to validate.
  if (taskType === 'user' || !task?.id || !workspacePath) return null;
  // A PortOS-owned audit can validly conclude that its shipped data is current.
  // `noChangesToShip` is only set by verifyPrClaim after the forge answered that
  // no PR exists AND the branch was proven empty; the task marker narrows this
  // exception to an explicitly opted-in autonomous job. Do not use the marker
  // as a general no-commit exemption: a real change still needs the commit probe.
  if (success && noChangesToShip === true && isVerifiedNoChangeTask(task)) return true;
  // A marked no-change audit needs a forge answer and an unambiguous empty-branch
  // proof. If either check was inconclusive, leave learning undeclared rather than
  // scoring a correct no-op as a commit miss. A non-empty branch remains a real
  // change path and still uses the ordinary commit criterion below.
  if (success && isVerifiedNoChangeTask(task) && noChangeProof?.inconclusive === true) return null;
  // Pipeline/media tasks deliver artifacts, not a commit — the
  // commit criterion doesn't apply, so don't mislabel a clean artifact run as a
  // validation miss (which would also pollute the correlation window). null =
  // no commit criterion declared for this task shape. Unlike programmatic-I/O
  // tasks they register no output hook, so there is no deliverable signal to
  // judge them by — they stay exit-code-judged (unchanged by #2727).
  if (task?.metadata?.pipeline || task?.metadata?.mediaJob) return null;
  // gh/git/external COORDINATOR task types (NON_COMMITTING_COORDINATOR_TASK_TYPES in
  // taskTypeHooks.js — branch-reconcile/issue-reconcile/branch-cleanup/jira-status-report)
  // deliver their work as a side effect — a merged PR, a resolved conflict, a deleted
  // branch, a posted report — and by design NEVER produce a commit. Because
  // their workspacePath IS set (the app's live checkout), the commit check above would
  // return false on every SUCCESSFUL run and drive their learning bucket to ~0% (#2696) —
  // the same artifact #2700 fixed for the programmatic-I/O reasoning run. They register no
  // output hook, so like pipeline/media jobs there is no deliverable signal to judge them
  // by; fall back to the exit code (null = criterion undeclared). Uses the predicate (not a
  // bare `scheduledType` lookup) so the archived `taskAnalysisType` shape resolves the same
  // way the learning bucket does — see isNonCommittingCoordinatorTask.
  //
  // ALSO covers the per-task `worktreeChangesExpected: false` signal the
  // tracker-filing types (reference-watch / ux) stamp at dispatch: on a
  // github/gitlab/jira app they file issues/tickets out of band and make no
  // commit at all, so the commit check would score every SUCCESSFUL run as a
  // failure — the #2696 artifact again. The flag is per-task, not type-keyed,
  // so the same type still gets its commit criterion on a `plan`-tracker app
  // where it legitimately commits PLAN.md items (#3273).
  if (declaresNoCommitCriterion(task)) return null;
  // No usable run window means no way to attribute a commit to THIS run — the
  // sentinel, not a false verdict (#3637).
  if (!Number.isFinite(startedAt)) return null;
  return await committedDuringRun(workspacePath, startedAt);
}

/**
 * The programmatic-I/O success criterion (#2727): "the agent's structured output
 * parsed and the output hook accepted it". Pure.
 *
 * The question this answers is about the AGENT'S OUTPUT, not about whether the
 * hook's downstream side effect ultimately landed. So a hook that accepted the
 * payload and then couldn't reach the tracker (`file-failed`, `tracker-read-failed`)
 * is NOT a failure of the run: the reasoning was sound and delivered, and a forge
 * outage is environmental. Blaming the run would tank the type's measured success
 * rate — and, through the shared classification below, auto-park the whole task
 * type — every time `gh` has a bad afternoon. Deliberate, not inherited: raised in
 * review on #2727 and kept.
 *
 * Delegates the accept/reject classification to `resolveTypeFailureSignal`, the
 * same pure decision the #2616 type-level failure ledger uses — so the learning
 * verdict and the ledger can never drift apart on what counts as a bad run, and a
 * new benign reason only has to be taught to one function.
 *
 * Sentinel discipline throughout — FOUR distinct answers, never collapsed:
 *   - `false` — the hook ran and REJECTED the output (threw, or `unparseable-response`).
 *   - `null`  — NOTHING evaluated the output (no hook ran, it timed out, or it
 *     returned no structured outcome), so no criterion was declared and
 *     task-learning falls back to the exit code exactly as before. "Not evaluated"
 *     must never become "accepted".
 *   - `true`  — the hook ran and accepted the output.
 *   - `SKIP_LEARNING_VERDICT` — the hook aborted BEFORE it could look at the
 *     output at all (`no-app` / `app-not-found`), so there is nothing to learn
 *     from and the run must not be recorded (#4107). Distinct from `null`,
 *     which still records the run against its exit code.
 *
 * @returns {boolean|null|'skip-learning'} true = accepted, false = rejected,
 *   null = undeclared, SKIP_LEARNING_VERDICT = do not record this run
 */
export function resolveProgrammaticIoVerdict({ success, hookResult }) {
  if (!hookResult?.ran) return null;
  // A thrown hook rejected the output. Classified FIRST: it carries no outcome (so
  // it must precede the outcome-shape guard), and a rejection shouldn't hinge on
  // the exit-code guard below.
  if (hookResult.threw) return false;
  // An absent/non-boolean exit-code verdict can't be weighed against anything.
  if (typeof success !== 'boolean') return null;
  // Ran, but handed back no structured outcome to read: nothing evaluated the
  // output, so declare no verdict rather than defaulting to "accepted".
  if (!hookResult.outcome || typeof hookResult.outcome !== 'object') return null;
  // Ran, but bailed out BEFORE it ever looked at the output (its app was deleted
  // mid-run, or the task carries no app). Nothing evaluated the agent's work and
  // the hook itself recorded nothing, so there is no honest verdict to bank:
  // `false` would blame the model for a user deleting an app mid-run (and poison
  // the #2329 failure-signature window with a non-failure), and the `null`
  // sentinel this used to return still recorded the run against its EXIT CODE —
  // an exit-0 run banked a free success for the task type (#4107). Skip the
  // learning write entirely instead.
  if (HOOK_ABORTED_BEFORE_EVALUATION.has(hookResult.outcome.reason)) return SKIP_LEARNING_VERDICT;
  if (hookResult.outcome.accepted === false) return false;
  if (hookResult.outcome.accepted === true) return true;
  return resolveTypeFailureSignal({ success, hookResult }).record === 'success';
}

// Output-hook outcomes that mean "the hook returned before validating the agent's
// output at all" — distinct from both a rejection and an acceptance.
const HOOK_ABORTED_BEFORE_EVALUATION = new Set(['no-app', 'app-not-found']);

/**
 * Error categories for the two ways a PR-shaped run can finish without a PR
 * (#3358). Distinct from each other AND from a generic failure, because the
 * remedies are opposite: `pr-missing` is the agent's miss, `forge-unreachable`
 * is the machine's — the run may have been perfect and simply had no way to
 * reach the forge. `forge-unreachable` is registered in
 * `taskLearning/store.js#ENVIRONMENTAL_ERROR_CATEGORIES` so a firewalled `gh`
 * can't drag a task type's measured success rate down (or auto-park it).
 */
export const PR_MISSING_CATEGORY = 'pr-missing';
export const FORGE_UNREACHABLE_CATEGORY = 'forge-unreachable';
export const ISSUE_TRAILER_MISSING_CATEGORY = 'issue-trailer-missing';

function hasIssueClosingTrailer(body, issueNumber) {
  return new RegExp(`\\b(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))\\s+#${issueNumber}\\b`, 'i').test(body);
}

function hasIssuePartialTrailer(body, issueNumber) {
  return new RegExp(`\\b(refs?|part of)\\s+#${issueNumber}\\b`, 'i').test(body);
}

function isVerifiedNoChangeTask(task) {
  const isPersistedTrue = (value) => value === true || value === 'true';
  return isPersistedTrue(task?.metadata?.autonomousJob) && isPersistedTrue(task?.metadata?.noChangeSuccess);
}

/**
 * The branch a finished agent's workspace is sitting on, or null when the
 * workspace is gone / not a repo / detached. Read at finalize time, while the
 * worktree still exists (cleanup runs after finalizeAgent in every spawn path).
 */
async function resolveWorkspaceBranch(workspacePath) {
  if (!workspacePath) return null;
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath, { ignoreExitCode: true })
    .catch(() => null);
  const branch = (result?.stdout || '').trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * How many commits the finished branch holds that its base does not — or `null`
 * when we could not work it out.
 *
 * The `null` sentinel matters: it is the difference between "we looked and the
 * agent committed nothing" and "we could not look". Only a confirmed `0` is
 * allowed to excuse a missing PR (see `verifyPrClaim`); an unreadable count
 * leaves the miss standing rather than inventing an excuse for it.
 *
 * Compares against `origin/<default>` in preference to the local branch. A
 * worktree's local `main` is routinely STALE — it is whatever the primary
 * checkout last pulled, which can sit well behind the commit the worktree was
 * actually branched from. Counting against it reports the merge commits the
 * agent inherited as commits the agent authored, which is precisely backwards
 * for a check that exists to recognize "this agent wrote nothing".
 */
async function countCommitsAhead(workspacePath) {
  const { getDefaultBranch } = await import('./git.js');
  // `allowRemote: false` — finalize must not block on a network round-trip to
  // answer a bookkeeping question; the local fallbacks resolve main/master fine.
  const defaultBranch = await getDefaultBranch(workspacePath, { allowRemote: false }).catch(() => null);
  if (!defaultBranch) return null;

  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  const hasRemote = await execGit(['rev-parse', '--verify', '--quiet', remoteRef], workspacePath, { ignoreExitCode: true })
    .then(r => !!(r?.stdout || '').trim())
    .catch(() => false);

  const base = hasRemote ? `origin/${defaultBranch}` : defaultBranch;
  const result = await execGit(['rev-list', '--count', `${base}..HEAD`], workspacePath, { ignoreExitCode: true })
    .catch(() => null);
  const count = Number.parseInt((result?.stdout || '').trim(), 10);
  return Number.isInteger(count) ? count : null;
}

/**
 * Verify that a run whose task shape PROMISED a pull request actually produced
 * one (#3358).
 *
 * The failure this closes: an agent that owns its own `/do:pr` step commits,
 * pushes over SSH (unaffected by an outbound block on `gh`), fails to create the
 * PR, writes its `.agent-done` sentinel anyway, and PortOS records "Completed
 * successfully" against a branch no one will ever review. Nothing else in the
 * completion path asks the forge whether the PR exists — `agentWorktreeCleanup`
 * only composes advisory prose SUGGESTING `gh pr list --head <branch>`.
 *
 * Only runs when `prExpected` — i.e. the AGENT owned PR creation. When PortOS
 * owns it (slashdo-free TUIs, runner mode) the PR is created by
 * `cleanupAgentWorktree` AFTER finalize, so checking here would report every
 * correct run as missing.
 *
 * Forge-aware: a GitLab repo is asked via `glab mr list`, mirroring the `gh`/
 * `glab` split `createPR` already makes. Asking `gh` about a GitLab remote
 * would fail and record every correct MR run as `forge-unreachable`.
 *
 * Four outcomes, never collapsed:
 *   - `ok: true`  — a PR exists with a valid claim trailer, or there was nothing to check
 *   - `ok: true, noChangesToShip: true` — the forge answered "no PR" and the
 *     branch holds no commits, so there was nothing a PR could have been opened
 *     for; the run concluded that no change was warranted
 *   - `ok: false, category: 'pr-missing'` — the forge answered "no PR" for a
 *     branch that DOES hold commits
 *   - `ok: false, category: 'forge-unreachable'` — we could not ask
 *
 * @returns {Promise<{ ok: boolean, category?: string, message?: string, branch?: string|null, noChangesToShip?: boolean, commitsAhead?: number|null, inconclusive?: boolean }>}
 * `inconclusive: true` is set for every requested check that cannot reach an
 * unambiguous answer (no resolvable branch, unreachable forge, unreadable claim
 * body, or unreadable commit count). It is omitted for a proven empty branch and
 * a readable non-empty branch missing its PR.
 */
export async function verifyPrClaim({ task, workspacePath, success, prExpected }) {
  // Only a run that CLAIMED success has a claim to verify; a failed run is
  // already recorded as failed.
  if (!prExpected || !success || !workspacePath) return { ok: true };
  const branch = await resolveWorkspaceBranch(workspacePath);
  if (!branch) {
    // No branch to ask about (detached HEAD, non-repo workspace). Nothing was
    // verified — say nothing rather than invent a failure.
    return { ok: true, branch: null, inconclusive: true };
  }

  const { resolveForgeForRepo } = await import('./git.js');
  // `env` carries the repo-owner-pinned `GH_TOKEN` the agent's own `gh pr create`
  // used. Dropping it would query as whatever ambient account `gh` happens to be
  // on, which on a multi-login host may not even see the PR — reading as
  // "no PR" for a run that opened one.
  const { cli, env } = await resolveForgeForRepo(workspacePath).catch(() => ({ cli: 'gh', env: null }));
  const found = cli === 'glab'
    ? await (await import('./gitlab.js')).findMergeRequestForBranch(branch, workspacePath)
    : await (await import('./github.js')).findPullRequestForBranch(branch, { cwd: workspacePath, env: env || null });

  const noun = cli === 'glab' ? 'merge request' : 'pull request';
  if (found.status === 'found') {
    const issueNumber = issueNumberFromRef(branch);
    if (issueNumber === null) return { ok: true, branch };
    if (typeof found.body !== 'string') {
      return {
        ok: false,
        branch,
        category: FORGE_UNREACHABLE_CATEGORY,
        message: `Could not read the ${noun} body for branch ${branch} to verify issue #${issueNumber}`,
        inconclusive: true,
      };
    }
    if (hasIssueClosingTrailer(found.body, issueNumber)) return { ok: true, branch };
    if (hasIssuePartialTrailer(found.body, issueNumber)) {
      return {
        ok: true,
        branch,
        advisory: `${noun[0].toUpperCase()}${noun.slice(1)} for branch ${branch} partially ships issue #${issueNumber}; reconcile the remaining scope after merge.`,
      };
    }
    return {
      ok: false,
      branch,
      category: ISSUE_TRAILER_MISSING_CATEGORY,
      message: `${noun[0].toUpperCase()}${noun.slice(1)} for branch ${branch} does not contain a closing trailer for issue #${issueNumber}`,
    };
  }
  if (found.status === 'none') {
    // "No PR" is only a MISS if there was something to open one for. An agent
    // that investigated its task, found the defect already fixed on main, and
    // stopped without touching a file leaves a branch with zero commits — and
    // `gh pr create` on a zero-commit branch does not fail because the agent
    // slipped, it fails because there is no diff. Recording that as `pr-missing`
    // failed a correct run and, being non-actionable, re-ran the whole
    // investigation twice more to reach the same conclusion (agent-446c4f47).
    //
    // Deliberately gated on an EXPLICIT 0: an unreadable count is not evidence
    // of an empty branch, so it leaves the miss standing.
    const ahead = await countCommitsAhead(workspacePath).catch(() => null);
    if (ahead === 0) {
      return { ok: true, branch, noChangesToShip: true };
    }
    return {
      ok: false,
      branch,
      commitsAhead: ahead,
      inconclusive: ahead === null,
      category: PR_MISSING_CATEGORY,
      message: `Agent reported success but no ${noun} exists for branch ${branch}`
    };
  }
  return {
    ok: false,
    branch,
    category: FORGE_UNREACHABLE_CATEGORY,
    message: `Could not confirm a ${noun} for branch ${branch} — the forge is unreachable${found.detail ? ` (${String(found.detail).split('\n')[0].slice(0, 120)})` : ''}`,
    inconclusive: true,
  };
}

/**
 * Branch-jack check (#3680): did this WORKTREE agent commit to the primary
 * checkout instead of its own worktree?
 *
 * Reads the `primaryCheckoutBaseline` that `agentLifecycle.js` stamped onto the
 * agent record at spawn time and re-reads that checkout now. Living here rather
 * than in the TUI spawner is what makes the guard apply to all three spawn modes
 * — TUI `finish()`, direct-CLI `close`, and runner-mode `handleAgentCompletion`
 * all funnel through `finalizeAgent` — without triplicating it.
 *
 * Non-worktree runs carry no baseline (they legitimately work IN the primary),
 * so they short-circuit to "no drift" before any git call.
 *
 * @returns {Promise<{drifted: boolean, message?: string, suggestedFix?: string, category?: string}>}
 */
export async function checkPrimaryCheckoutDrift(agentId) {
  const agent = await getAgentRecord(agentId).catch(() => null);
  const baseline = agent?.metadata?.primaryCheckoutBaseline || null;
  if (!baseline) return { drifted: false };
  return await detectPrimaryCheckoutDrift(baseline, { agentBranch: agent?.metadata?.worktreeBranch || null });
}

/**
 * The `errorAnalysis` shape for a detected branch-jack. `actionable` because a
 * human has to decide whether to discard the primary's commits — a retry cannot
 * repair this, and silently retrying would leave the mutated checkout in place.
 */
function primaryCheckoutDriftAnalysis(drift) {
  return {
    category: drift.category,
    // Observed by the spawner from the checkout's own git state, not scraped out
    // of the transcript — the same provenance rule the structural analyses use.
    origin: 'runner',
    completionReason: PRIMARY_CHECKOUT_MUTATED_REASON,
    actionable: true,
    escalation: PRIMARY_CHECKOUT_MUTATED_ESCALATION,
    message: drift.message,
    suggestedFix: drift.suggestedFix
  };
}

/**
 * The `errorAnalysis` shape for a failed PR verification. Non-actionable so the
 * task RETRIES (a re-run can open the missing PR, or find the forge back) rather
 * than blocking on a first miss — `resolveFailedTaskDecision` still blocks it
 * once it has burned its retry budget.
 */
function prVerificationAnalysis(verdict) {
  return {
    category: verdict.category,
    message: verdict.message,
    actionable: false,
    suggestedFix: verdict.category === PR_MISSING_CATEGORY
      ? `The branch ${verdict.branch} holds ${verdict.commitsAhead ?? 'unreviewed'} commit(s) but has no open change request. Re-run the task, or open it by hand (\`gh pr create --head ${verdict.branch}\` / \`glab mr create --source-branch ${verdict.branch}\`).`
      : 'Check the forge probe on the System Health page — the forge CLI could not reach the forge, so the run\'s change request could not be confirmed.'
  };
}

/**
 * Goal-fidelity completion gate (#5994).
 *
 * Every other check on this path proves the run PRODUCED something: the commit
 * probe proves commits exist, `verifyPrClaim` proves a change request was
 * opened, the reviewer chain proves the diff is decent code. None of them can
 * prove it is the change that was ASKED for — the reviewers are handed a diff
 * with no objective attached, by design. So a run can be clean, reviewed, green
 * in CI, and quietly deliver something else.
 *
 * This reads the accumulated run-window diff against the TASK's own stated
 * objective, in a fresh context. Fresh context is the mechanism: a reviewer
 * given the agent's transcript inherits the assumptions that produced the drift,
 * so the objective comes from the task record and nothing else.
 *
 * Fail-OPEN throughout. Every decline path — gate off, no local backend, no
 * objective, no readable diff, a reviewer that errored or answered with prose —
 * returns a result carrying NO verdict, and the caller leaves the run's outcome
 * exactly as it found it. A gate that could hold a run because a local model was
 * down would be worse than no gate: it would convert an ollama restart into a
 * queue of runs marked needs-attention.
 *
 * @returns {Promise<{verdict: string|null, review: Object|null, error: string|null}>}
 */
async function evaluateGoalFidelity({ task, workspacePath, startedAt }) {
  const none = (error = null) => ({ verdict: null, review: null, error });
  if (!workspacePath || !task?.id) return none();
  const objective = taskObjective(task);
  if (!objective) return none();
  const config = await getGoalFidelityConfig().catch(() => null);
  if (!config) return none();

  const { diff, reason, truncated } = await runWindowDiff(workspacePath, startedAt, { maxChars: MAX_FIDELITY_DIFF_CHARS });
  // `reason` = git could not answer; `''` = the run committed nothing. Both skip
  // the review, and neither is a finding: a run with no diff is judged by the
  // commit criterion, which is the check that actually owns that question.
  if (reason || !diff) return none();

  const result = await runLocalGoalFidelityReview({
    backend: config.backend,
    model: config.model,
    effort: config.effort,
    objective,
    diff,
  }).catch(err => ({ ok: false, error: err.message }));
  if (!result?.ok) return none(result?.error || 'goal-fidelity review returned no verdict');
  return {
    verdict: result.verdict,
    review: {
      verdict: result.verdict,
      missing: result.missing,
      unrequested: result.unrequested,
      evidence: result.evidence,
      backend: result.backend,
      model: result.model,
      ...(truncated ? { diffTruncated: true } : {}),
      checkedAt: new Date().toISOString(),
    },
    error: null,
  };
}

/** `errorAnalysis` for a run held by the goal-fidelity gate. */
function goalFidelityAnalysis(review) {
  const named = [...(review.missing || []), ...(review.unrequested || [])];
  return {
    category: GOAL_FIDELITY_CATEGORY,
    message: `${formatGoalFidelitySummary(review)} — the diff does not deliver the task's stated objective`,
    actionable: false,
    origin: 'goal-fidelity-review',
    suggestedFix: named.length
      ? `Re-read the task against the change and reconcile: ${named.slice(0, 3).join('; ')}.`
      : 'Re-read the task against the change: the review found the work does something other than what was asked.',
  };
}

/**
 * Hard bound on output-hook dispatch (#2727). The hook is only awaited BEFORE
 * `completeAgent` so its verdict can be recorded — but `status: 'running'` is what
 * the CoS concurrency gate counts (`cos.js`, default 3 slots), and that flips in
 * completeAgent. So an un-bounded hook (it shells out to `gh`/`glab` and can walk
 * up to 50 embeddings for semantic dedup) would hold a slot for its whole
 * duration, and a HUNG one would hold it until restart — with the task stuck
 * `in_progress` and the orphan reaper protecting the zombie rather than reaping
 * it, because it too filters on `status === 'running'`.
 *
 * A timeout resolves to the "no verdict" sentinel, NOT a rejection: a hook we
 * stopped waiting for told us nothing about the agent's output, so finalize
 * proceeds and task-learning falls back to the exit code (the pre-#2727
 * behavior). Generous by design — this is a hang backstop, not a latency budget;
 * a slow-but-honest hook should still get to return its real verdict.
 *
 * Timing out only stops us WAITING — it can't cancel the hook, which keeps running
 * and still lands its side effects (filing the issue, recording the run). That's
 * the desired trade: the work completes, it just no longer pins a concurrency slot
 * or gates the completion write. A late rejection is still handled (Promise.race
 * subscribes to both), so it can't surface as an unhandled rejection.
 */
const OUTPUT_HOOK_TIMEOUT_MS = 5 * 60_000;
const outputHookDispatches = new Map();

export function withOutputHookTimeout(promise, { agentId, timeoutMs = OUTPUT_HOOK_TIMEOUT_MS }) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      // Resolve BEFORE logging, and never let the log throw out of the callback:
      // this runs outside the request lifecycle, so an uncaught throw here would
      // crash the process — and a throw before `resolve` would leave the race
      // permanently unsettled, wedging the exact finalize this timer exists to
      // rescue.
      resolve({ ran: false, timedOut: true });
      try {
        emitLog('error', `⏱️ processTaskOutput hook timed out after ${timeoutMs}ms for ${agentId} — finalizing with no verdict`, { agentId });
      } catch (err) {
        console.error(`❌ Failed to log output-hook timeout for ${agentId}: ${err.message}`);
      }
    }, timeoutMs);
    // Never let the backstop itself hold the event loop open.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run an agent's task-type output hook at most once, including completion paths
 * that bypass finalizeAgent after a restart or orphan reap.
 *
 * The persisted marker closes the sequential normal/recovery gap; the per-agent
 * promise closes the smaller same-process race where two completion paths both
 * observe a running, unmarked agent before either hook finishes.
 */
export function dispatchTaskOutputHookOnce({
  agentId,
  task,
  success,
  workspacePath = null,
  readPayload = true,
  recovery = false,
}) {
  const existing = outputHookDispatches.get(agentId);
  if (existing) return existing;

  const persistDispatchMarker = async (result) => {
    if (!result.ran) return;
    // Best-effort durability: completion must continue if the marker write
    // fails, while the in-flight promise still protects concurrent callers
    // this cycle.
    await updateAgent(agentId, {
      metadata: { outputHookDispatchedAt: new Date().toISOString() }
    }).catch(err => {
      emitLog('warn', `⚠️ Failed to persist output-hook dispatch marker for ${agentId}: ${err.message}`, { agentId });
    });
  };

  const dispatch = (async () => {
    const agent = await getAgent(agentId).catch(() => null);
    if (agent?.metadata?.outputHookDispatchedAt) {
      return { ran: false, alreadyDispatched: true };
    }

    const hookDispatch = dispatchTaskOutputHook({
      agentId,
      task,
      success,
      workspacePath,
      readPayload,
      recovery,
    }).catch(err => {
      emitLog('error', `❌ processTaskOutput hook threw for ${agentId} (${task?.taskType}): ${err.message}`, { agentId, error: err.message });
      return { ran: true, threw: true };
    });
    const result = await withOutputHookTimeout(hookDispatch, { agentId });

    if (result.timedOut) {
      // The hook is still running. Keep this dispatch in the in-process map so
      // another completion path cannot start a duplicate, and persist the
      // durable marker only after the original hook actually settles. If the
      // process exits first, restart recovery remains free to retry it.
      hookDispatch
        .then(persistDispatchMarker)
        .finally(() => {
          if (outputHookDispatches.get(agentId) === dispatch) {
            outputHookDispatches.delete(agentId);
          }
        });
    } else {
      await persistDispatchMarker(result);
    }
    return result;
  })();

  outputHookDispatches.set(agentId, dispatch);
  dispatch.then(result => {
    if (!result.timedOut && outputHookDispatches.get(agentId) === dispatch) {
      outputHookDispatches.delete(agentId);
    }
  }).catch(() => {
    if (outputHookDispatches.get(agentId) === dispatch) {
      outputHookDispatches.delete(agentId);
    }
  });
  return dispatch;
}

/**
 * Recovery paths try the agent's persisted workspace when it still exists.
 * When it does not, only hooks whose registry contract says they are
 * payload-independent may run with null output.
 */
export function dispatchRecoveredTaskOutputHook({ agentId, task, success, workspacePath = null }) {
  return dispatchTaskOutputHookOnce({
    agentId,
    task,
    success,
    workspacePath,
    readPayload: !!workspacePath,
    recovery: true,
  });
}

/**
 * Stamp an LI hand-off's per-proposal execution verdict into a completion `taskUpdate`'s
 * federated metadata (#2779), mutating `taskUpdate.metadata` in place. Shared by every
 * agent-completion path that marks an LI hand-off task terminal — finalizeAgent (the main
 * path) AND the post-restart recovery path in handleAgentCompletion — so a hand-off that
 * completes through a bypass still federates its outcome to the originating peer (codex P2);
 * without this only finalizeAgent-completed hand-offs would ever reach peer A.
 *
 * `buildLiExecutionVerdict` reuses the exact validation-authoritative outcome + environmental
 * gate the LOCAL #2765 write uses, so both peers record the identical verdict; a non-hand-off
 * task (no `liProposal`) or an environmental completion yields null (no stamp). Best-effort
 * and defensive (runs outside the request lifecycle): a lazy-import/build failure logs and
 * leaves `taskUpdate` unstamped rather than throwing into the completion path. Lazy imports
 * keep the taskLearning/LI graphs off agentLifecycle's static chain.
 *
 * @param {object} taskUpdate  the update object about to be passed to updateTask (mutated)
 * @param {object} task        the persisted task (carries `metadata.liProposal` when a hand-off)
 * @param {{ success:boolean, validationPassed?:boolean|null, errorAnalysis?:object|null }} signals
 * @returns {Promise<object>} the same `taskUpdate` (stamped when applicable)
 */
export async function stampLiExecutionVerdict(taskUpdate, task, { success, validationPassed = null, errorAnalysis = null } = {}) {
  const liProposal = task?.metadata?.liProposal || null;
  if (!liProposal) return taskUpdate;
  try {
    const [{ buildLiExecutionVerdict }, { LI_EXECUTION_VERDICT_KEY }] = await Promise.all([
      import('./taskLearning/metrics.js'),
      import('./layeredIntelligenceOutcomes.js')
    ]);
    const verdict = buildLiExecutionVerdict({ liProposal, success, validationPassed, errorAnalysis, executedAt: new Date().toISOString() });
    if (verdict) {
      taskUpdate.metadata = { ...(taskUpdate.metadata || {}), [LI_EXECUTION_VERDICT_KEY]: verdict };
    }
  } catch (err) {
    emitLog('warn', `⚠️ Failed to stamp LI execution verdict for task ${task?.id}: ${err.message}`, { taskId: task?.id });
  }
  return taskUpdate;
}

/**
 * Shared end-of-run state writes for all three spawn paths
 * (`handleAgentCompletion` runner-mode, TUI `finish`, direct-CLI `close`).
 * Path-specific cleanup (worktree, sentinel removal, pty kill, in-memory
 * map deletes) stays at the calling site; lane release + execution
 * tracking should fire EARLIER via `releaseAgentLane()` — this helper
 * owns the centralized state writes only.
 */
export async function finalizeAgent({
  agentId,
  task,
  runId,
  providerId,
  success: reportedSuccess,
  exitCode,
  duration,
  outputBuffer,
  errorAnalysis: reportedErrorAnalysis,
  terminatedByUser = false,
  isTruthyMetaFn,
  error,
  completionReason,
  workspacePath = null,
  prExpected = false,
  startedAt = null,
}) {
  // The run window the commit criterion is evaluated against (#3637). Callers
  // that don't track their own start timestamp still know how long the run took,
  // and `duration` is measured from the same instant, so derive it — a missing
  // window would otherwise leave every such path permanently undeclared.
  //
  // `duration > 0`, not `>= 0`: the spawn-rejected path reports a zero-length
  // run because the agent never started. A window that cannot contain a commit
  // is not evidence of one, so it stays the null sentinel ("no criterion
  // evaluated") rather than recording a run that never happened as a miss.
  const runStartedAt = Number.isFinite(startedAt)
    ? startedAt
    : (Number.isFinite(duration) && duration > 0 ? Date.now() - duration : null);
  // #3358: a run whose task shape promised a PR is not successful until the
  // forge confirms one exists. Runs BEFORE the completion verdict is derived so
  // every downstream write (task status, learning telemetry, the "Completed
  // successfully" the UI renders off `result.success`) sees the corrected value.
  // A THROW here is not a verdict — fall back to the reported outcome rather
  // than manufacturing a failure out of a check that never ran.
  let prCheckThrew = false;
  const noChangeAudit = !terminatedByUser && reportedSuccess && isVerifiedNoChangeTask(task);
  const prVerdict = terminatedByUser
    ? { ok: true }
    : await verifyPrClaim({ task, workspacePath, success: reportedSuccess, prExpected })
      .catch(err => {
        prCheckThrew = true;
        emitLog('warn', `⚠️ PR verification failed for ${agentId}: ${err.message}`, { agentId });
        return { ok: true };
      });

  // Codex/Antigravity/OpenCode sessions can own the PR workflow without being
  // able to type slashdo commands, so their spawners deliberately pass
  // `prExpected: false` and let cleanup act as the PR-creation backstop. A
  // marked catalog audit still needs the same forge + empty-branch proof before
  // a clean exit can satisfy its no-change success criterion. Keep this
  // auxiliary verdict separate: a non-empty branch must remain eligible for
  // cleanup to open the PR after finalize rather than being downgraded here.
  const noChangeProof = noChangeAudit
    ? prExpected
      ? (prCheckThrew
          ? { ok: false, category: FORGE_UNREACHABLE_CATEGORY, inconclusive: true }
          : prVerdict)
      : await verifyPrClaim({ task, workspacePath, success: reportedSuccess, prExpected: true })
        .catch(err => {
          emitLog('warn', `⚠️ No-change verification failed for ${agentId}: ${err.message}`, { agentId });
          return { ok: false, category: FORGE_UNREACHABLE_CATEGORY, inconclusive: true };
        })
    : null;
  const effectivePrVerdict = typeof prVerdict.branch === 'string'
    ? prVerdict
    : (noChangeProof?.noChangesToShip === true ? noChangeProof : prVerdict);
  const noChangesToShip = prVerdict.noChangesToShip === true || noChangeProof?.noChangesToShip === true;

  // Record the verdict in the lifecycle ledger (#4540) — but ONLY when the
  // check actually reached one. `verifyPrClaim` returns the same `{ ok: true }`
  // for "the PR is there", for "this run never promised one", for "there was no
  // branch to ask about", and (via the catch above) for "the check threw";
  // appending on every call would file four different facts under one word and
  // make the ledger lie about the one transition it exists to explain.
  //
  // A BRANCH is the tell: every path that actually consulted a forge returns the
  // branch it asked about, and every path that did not returns no branch at all.
  // So gate on the branch rather than re-deriving the service's own
  // applicability rules here, where they would drift apart.
  //
  // `forge-unreachable` is excluded for the same reason a throw is: the forge
  // being down is not evidence about the PR. Recording it as `verified: false`
  // would put "this run shipped no PR" on the record for a run that may well
  // have shipped one.
  if (!prCheckThrew && typeof effectivePrVerdict.branch === 'string' && effectivePrVerdict.category !== FORGE_UNREACHABLE_CATEGORY) {
    const verified = effectivePrVerdict.ok === true;
    await appendRunEvent({
      kind: 'run.pr-verified',
      runId,
      agentId,
      taskId: task?.id,
      // Keyed on the run AND the verdict. The run part collapses a retried
      // finalize (the close handler and the orphan sweep can both reach this
      // path) into one entry; the verdict part keeps a run whose SECOND check
      // found the PR its first check missed from being silently suppressed by
      // the miss — that transition is the whole reason to look at the ledger.
      eventId: `pr-verify:${agentId}:${runId || 'no-run'}:${verified ? 'ok' : effectivePrVerdict.category || 'failed'}`,
      data: {
        verified,
        branch: effectivePrVerdict.branch ?? null,
        category: effectivePrVerdict.category ?? null,
        noChangesToShip: effectivePrVerdict.noChangesToShip === true,
      },
    });
  }

  // #3680: a worktree agent that committed to the PRIMARY checkout left
  // unreviewed commits on an unprotected branch. Same posture as the PR check —
  // a throw is not a verdict, so fall back to "no drift" rather than
  // manufacturing a failure out of a check that never ran.
  const drift = await checkPrimaryCheckoutDrift(agentId).catch(err => {
    emitLog('warn', `⚠️ Primary-checkout drift check failed for ${agentId}: ${err.message}`, { agentId });
    return { drifted: false };
  });
  if (drift.drifted) {
    emitLog('warn', `⚠️ ${drift.message} — reported by ${agentId}; PortOS will not repair it automatically`, {
      agentId, taskId: task?.id, category: drift.category
    });
  } else if (drift.unattributed) {
    // #3703: commits WERE stranded on the primary, but none are patch-equivalent
    // to this agent's own branch — another actor (a coding-on-main agent, the
    // human's terminal, `update.sh`'s pull) moved it. Unreviewed commits on the
    // primary are still worth surfacing, but this run did not cause them, so it is
    // warn-logged WITHOUT downgrading an otherwise-successful run to a failure.
    emitLog('warn', `⚠️ ${drift.message} — not attributable to ${agentId}; surfacing without failing the run`, {
      agentId, taskId: task?.id
    });
  } else if (drift.fastForwarded) {
    // Movement without stranded commits — a pull, not a branch-jack. Logged so
    // "the primary moved during this run" stays visible without being a failure.
    emitLog('info', `↪️ Primary checkout moved ${drift.commitCount ?? '?'} commit(s) during ${agentId}, all already upstream — not a branch-jack`, {
      agentId, taskId: task?.id
    });
  }
  // A drift downgrade only OVERRIDES a run that would otherwise have been
  // recorded a success. On a run that already failed, the original analysis is
  // the better diagnosis of why it failed, and the branch-jack is already on the
  // record via the warn above — replacing it would trade a real cause for a
  // side effect. Same reason `terminatedByUser` keeps its own verdict.
  const driftDowngrade = drift.drifted && reportedSuccess && !terminatedByUser;

  let success = reportedSuccess && prVerdict.ok && !driftDowngrade;
  let errorAnalysis = driftDowngrade
    ? primaryCheckoutDriftAnalysis(drift)
    : prVerdict.ok ? reportedErrorAnalysis : prVerificationAnalysis(prVerdict);
  if (!prVerdict.ok) {
    emitLog('warn', `⚠️ ${prVerdict.message} — recording ${agentId} as needs-attention (${prVerdict.category}) rather than complete`, {
      agentId, taskId: task?.id, branch: prVerdict.branch, category: prVerdict.category
    });
  } else if (noChangesToShip) {
    // A no-op run is a legitimate completion, not a silent one — the human still
    // wants to know a task burned an agent and concluded there was nothing to do.
    const noChangeBranch = effectivePrVerdict.branch || noChangeProof?.branch;
    emitLog('info', `🫧 ${agentId} opened no change request and committed nothing to ${noChangeBranch} — recording the run as complete with no change warranted`, {
      agentId, taskId: task?.id, branch: noChangeBranch
    });
  }

  // #5994: the run shipped — but did it ship what was asked? Runs only on a run
  // that would otherwise be recorded a success, for the same reason the drift
  // downgrade does: on a run that already failed, the original analysis is the
  // better diagnosis, and re-judging it against the objective would replace a
  // real cause with a symptom. Bounded by the reviewer's own request timeout and
  // the diff probe's git timeouts — it holds the agent's CoS concurrency slot for
  // its duration, which is why it is skipped entirely unless the user configured
  // a local backend for it.
  const fidelity = success
    ? await evaluateGoalFidelity({ task, workspacePath, startedAt: runStartedAt })
      .catch(err => {
        emitLog('warn', `⚠️ Goal-fidelity review failed for ${agentId}: ${err.message}`, { agentId });
        return { verdict: null, review: null, error: err.message };
      })
    : { verdict: null, review: null, error: null };
  const fidelityDowngrade = goalFidelityHoldsRun(fidelity.review);
  if (fidelity.review) {
    emitLog(fidelityDowngrade ? 'warn' : 'info', `${fidelityDowngrade ? '🎯' : '✅'} ${formatGoalFidelitySummary(fidelity.review)} for ${agentId}`, {
      agentId, taskId: task?.id, verdict: fidelity.verdict
    });
  } else if (fidelity.error) {
    emitLog('warn', `⚠️ Goal-fidelity review returned no verdict for ${agentId}: ${fidelity.error}`, { agentId, taskId: task?.id });
  }
  if (fidelityDowngrade) {
    success = false;
    errorAnalysis = goalFidelityAnalysis(fidelity.review);
    // The Review Hub bridges this into a review alert: a run held because it
    // built the wrong thing is exactly the case a human has to look at, and the
    // named missing/unrequested items are what make the hold actionable.
    cosEvents.emit(GOAL_FIDELITY_HOLD_EVENT, { agentId, taskId: task?.id, review: fidelity.review });
  }

  if (success && isTruthyMetaFn) {
    await persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn);
  }

  const taskType = task?.taskType || 'user';
  let taskUpdate = terminatedByUser
    ? {
      status: 'blocked',
      metadata: {
        ...task.metadata,
        blockedReason: 'Terminated by user',
        blockedCategory: 'user-terminated',
        blockedAt: new Date().toISOString(),
      },
    }
    : success
      ? { status: 'completed' }
      : await resolveFailedTaskUpdate(task, errorAnalysis, agentId);

  // Programmatic-I/O task types (e.g. layered-intelligence) run a deterministic
  // post-agent step on the agent's STRUCTURED output — the parsed `.agent-done`
  // payload — rather than only handling the completion sentinel. Read + dispatch
  // it mode-agnostically here (the single finalize chokepoint for TUI/CLI/runner
  // agents), gated on the task type actually registering an output hook so a
  // normal agent pays no extra I/O. Its side effects (filing an issue, etc.) are
  // isolated from the agent's discarded worktree — the payload is the only
  // durable channel out. Errors are caught: a hook failure must not strand the
  // rest of finalize. See taskTypeHooks.js + the design plan.
  //
  // Ordering (#2727): this runs BEFORE completeAgent because the hook result is
  // the only signal that can judge a programmatic-I/O run (see
  // evaluateSuccessCriteria), and completeAgent is what writes the learning
  // verdict — so the judgement has to exist first. Safe for every other task
  // shape: dispatchTaskOutputHook is a no-op unless the type registers a hook
  // (isProgrammaticIoTaskType), so nothing else is reordered. The lane is already
  // released by this point (releaseAgentLane fires earlier, in the spawn paths),
  // and `agent:completed` — which schedules the next dequeue — still fires from
  // completeAgent below, i.e. AFTER any handoff task the hook enqueues. The cost
  // of awaiting here is that the agent still counts against the CoS concurrency
  // gate for the hook's duration, so the dispatch is hard-bounded — see
  // withOutputHookTimeout.
  const hookResult = await dispatchTaskOutputHookOnce({ agentId, task, success, workspacePath });

  // Output hooks may return a trusted metadata patch that advances a staged
  // workflow. Apply it before task persistence and cleanup so the next stage
  // sees the narrowed input set. An explicit `accepted: false` is a real
  // programmatic-output failure even when the agent exited zero; this is the
  // fail-closed path for incomplete or contradictory eligibility envelopes.
  const hookOutcome = hookResult?.outcome;
  const hookMetadata = hookOutcome?.taskMetadata && typeof hookOutcome.taskMetadata === 'object'
    && !Array.isArray(hookOutcome.taskMetadata)
    ? hookOutcome.taskMetadata
    : null;
  if (hookMetadata) {
    task.metadata = { ...task.metadata, ...hookMetadata };
  }
  const hookRejected = !terminatedByUser && hookResult?.ran && hookOutcome?.accepted === false;
  // A PERMANENT hook rejection (#6124) — the stage produced no parseable output
  // at all — re-fails identically on every retry, so it blocks instead of
  // burning MAX_TASK_RETRIES spawns and (for a pipeline whose generator keys its
  // dedup on a live task) re-generating behind them. Honoured only when the run
  // named no other cause: an exit-0 run, or a failure whose category is the
  // `unknown` that an empty run produces. A run that failed for a NAMED reason
  // (rate-limit, auth-error, a killed provider) keeps its ordinary retries —
  // that output is missing because the environment misbehaved, not because the
  // stage can never produce one.
  const causeNamed = !success && errorAnalysis?.category && errorAnalysis.category !== 'unknown';
  const hookPermanent = hookRejected && hookOutcome?.permanent === true && !causeNamed;
  // When the run had already failed, `taskUpdate` holds its retry decision. Only
  // escalate a decision that is still retrying — a task this run already blocked
  // is terminal, and re-resolving it would file a second investigation task.
  const escalatePermanent = hookPermanent && !success && taskUpdate?.status !== 'blocked';
  if (hookRejected && (success || escalatePermanent)) {
    success = false;
    errorAnalysis = {
      category: hookOutcome.reason || 'output-hook-rejected',
      message: hookOutcome.message || 'The scheduled task output was rejected by its validation hook',
      actionable: false,
      ...(hookPermanent && { permanent: true }),
      origin: 'task-output-hook',
    };
    taskUpdate = await resolveFailedTaskUpdate(task, errorAnalysis, agentId);
  } else if (hookMetadata && success && !terminatedByUser) {
    taskUpdate = { ...taskUpdate, metadata: task.metadata };
  }

  // Success-criteria validation (issue #2344): stamp an explicit pass/fail (or
  // null-when-undeclared) verdict onto the completion result, distinct from the
  // exit-code `success`, so task-learning telemetry can distinguish "ran clean
  // but produced nothing" from a genuine success. Best-effort — a validation
  // check failure must never block finalize (falls back to the null sentinel).
  const validationPassed = await evaluateSuccessCriteria({
    task,
    terminatedByUser,
    workspacePath,
    startedAt: runStartedAt,
    success,
    hookResult,
    noChangesToShip,
    noChangeProof,
  })
    .catch(err => {
      emitLog('warn', `⚠️ Success-criteria validation failed for ${agentId}: ${err.message}`, { agentId });
      return null;
    });

  // Sequential by design: completeAgent + updateTask share the cosState
  // mutex (`withStateLock`) so parallelism gains nothing, AND ordering
  // matters — if completeAgent throws, we must not mark the task completed.
  // completeAgentRun writes its own runs/<id>/metadata.json (separate lock),
  // so its place in the chain is purely about progress reporting on partial
  // failure.
  // A PR-verification downgrade carries its own error text + reason: without
  // them the agent card would render a bare "Failed" for a run that actually
  // did everything but land its PR (or simply couldn't reach the forge).
  // A branch-jack downgrade (#3680) carries its own text + reason for the same
  // reason the PR downgrade does, and outranks it: the run may well have opened
  // its PR fine and still mutated the primary, and THAT is the thing a human has
  // to act on.
  // A goal-fidelity hold (#5994) sits below both: a branch-jack and a missing PR
  // are facts about what the run did to the repo, while this is a judgement about
  // what it built — and when a run both missed its PR and drifted, the missing PR
  // is the more concrete thing to act on first.
  const finalError = driftDowngrade
    ? drift.message
    : !prVerdict.ok
      ? prVerdict.message
      : fidelityDowngrade
        ? errorAnalysis?.message
        : hookRejected
          ? errorAnalysis?.message || error
          : error;
  const finalCompletionReason = driftDowngrade
    ? PRIMARY_CHECKOUT_MUTATED_REASON
    : !prVerdict.ok
      ? prVerdict.category
      : fidelityDowngrade
        ? GOAL_FIDELITY_CATEGORY
        : hookRejected
          ? errorAnalysis?.category || completionReason
          : completionReason;

  await completeAgent(agentId, {
    success,
    validationPassed,
    exitCode,
    duration,
    outputLength: outputBuffer?.length ?? 0,
    errorAnalysis,
    // Recorded whatever the verdict — a `ship` is the evidence that the gate ran
    // and cleared the run, which is what makes a run with no `goalFidelity` block
    // legible as "never judged" rather than "judged fine".
    ...(fidelity.review ? { goalFidelity: fidelity.review } : {}),
    ...(finalError !== undefined ? { error: finalError } : {}),
    ...(finalCompletionReason !== undefined ? { completionReason: finalCompletionReason } : {}),
  });

  if (runId) {
    // Pass the downgrade explicitly: this run exited 0, so the run record would
    // otherwise keep saying "success" for the one run we just concluded did not
    // land its PR (#3358).
    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis, prVerdict.ok && !driftDowngrade && !fidelityDowngrade ? null : false);
  }

  // LI hand-off execution verdict (#2779): stamp the per-proposal execution outcome into
  // the task's FEDERATED metadata as part of this completion write, so the originating peer
  // (which filed the proposal and runs LI for that app) can derive `recordProposalExecution`
  // from the terminal synced task — cross-peer parity for the #2765 LOCAL write, which only
  // lands on the peer that ran the agent.
  await stampLiExecutionVerdict(taskUpdate, task, { success, validationPassed, errorAnalysis });

  const taskResult = await updateTask(task.id, taskUpdate, taskType);
  if (taskResult?.error) {
    const label = terminatedByUser ? 'blocked' : success ? 'completed' : 'failed';
    emitLog('warn', `⚠️ Failed to update ${label} task ${task.id}: ${taskResult.error} (taskType=${taskType})`, { taskId: task.id, agentId, error: taskResult.error });
  }

  if (!success && !terminatedByUser && errorAnalysis) {
    // Bench the provider when the PROVIDER is what failed — not the agent's
    // work. `origin: 'provider'` is agentErrorAnalysis's provenance flag (#2642),
    // set only for structured provider chrome, never for a loose keyword sweep of
    // a transcript the agent itself wrote. Without a bench the provider stays
    // "available", so the very next dequeue picks it again and dies identically:
    // that is how one `agy` account-verification block could take down a whole
    // queue of tasks in under a minute. `resolveProviderBench` (shared with
    // promptRunner) picks the window and declines to bench request-specific
    // failures; the cooldown then routes the retry to a fallback
    // (agentProviderResolution.js) and auto-expires without anyone intervening.
    // Provenance is the WHOLE gate — deliberately not `|| category === 'usage-limit'
    // || category === 'rate-limit'`, which is what this used to key on. Those
    // categories have loose alternatives (a bare "rate limit" / "quota exceeded" an
    // agent's own failing test can print), so a category-only check benches a
    // healthy provider off the agent's transcript. Genuine limits already carry
    // `origin: 'provider'` via their `structuredMarker`, so nothing real is lost.
    // Every finalizeAgent caller analyzes through analyzeAgentFailure or
    // detectImmediateFallbackSignal, and both stamp an origin on every branch.
    const bench = errorAnalysis.origin === 'provider' ? resolveProviderBench(errorAnalysis) : null;
    // Lazy provider lookup — resolve the active provider only when a marker
    // fires AND the caller didn't already know the id, keeping the ordinary
    // failure path free of a settings-file read.
    const markerProviderId = bench ? providerId || (await getActiveProvider())?.id : null;
    if (markerProviderId) {
      // `markUsageLimit` parses its own window out of the provider's message
      // ("resets 5pm"), so a usage limit keeps its dedicated marker.
      const mark = bench.marker === 'usage-limit'
        ? markProviderUsageLimit(markerProviderId, errorAnalysis)
        : markProviderUnavailable(markerProviderId, {
          reason: bench.category,
          message: bench.message || 'Provider unavailable',
          waitTimeMs: bench.waitTimeMs
        });
      await mark.catch(err => {
        emitLog('warn', `Failed to sideline provider: ${err.message}`, { providerId: markerProviderId, category: bench.category });
      });
    }
  }

  // Type-level consecutive-failure ledger (#2616): feed the per-type
  // backoff/auto-park in taskSchedule. Only SCHEDULED task types carry
  // `metadata.analysisType`; user/ad-hoc tasks don't participate — so this gate
  // deliberately does NOT use resolveTaskHookType (#2727). That resolver falls back
  // to `task.taskType`, which for an ad-hoc task is the CoS queue category
  // ('internal', 'user'); ledgering those would invent a failure ledger for a
  // "task type" that no schedule owns. "Which tasks run a hook" and "which task
  // types back off" are genuinely different questions. The pure
  // resolveTypeFailureSignal decides success vs failure vs skip — including the
  // exit-0-but-unparseable-output case that must count as a failure.
  const scheduledType = task?.metadata?.analysisType || null;
  if (scheduledType) {
    const signal = resolveTypeFailureSignal({
      success,
      terminatedByUser,
      hookResult,
      errorCategory: errorAnalysis?.category
    });
    if (signal.record !== 'skip') {
      const ledgerAppId = task?.metadata?.app || null;
      const { recordTaskTypeFailure, recordTaskTypeSuccess } = await import('./taskSchedule.js');
      const ledgerUpdate = signal.record === 'failure'
        ? recordTaskTypeFailure(scheduledType, ledgerAppId, { errorCategory: signal.category })
        : recordTaskTypeSuccess(scheduledType, ledgerAppId);
      await ledgerUpdate.catch(err => {
        emitLog('warn', `⚠️ Task-type ledger update failed for ${scheduledType}: ${err.message}`, { taskType: scheduledType, agentId });
      });
    }
  }

  await processAgentCompletion(agentId, task, success, outputBuffer);

  if (usesCreativeDirectorScratchCwd(task)) {
    await removeCreativeDirectorScratchCwd(agentId).catch((err) => {
      emitLog('warn', `⚠️ CD scratch cleanup failed for ${agentId}: ${err.message}`, { agentId });
    });
  }

  // Hand the CORRECTED verdict back so the caller's worktree cleanup runs on the
  // same answer this function just persisted (#3358). Without it, a run
  // downgraded to `pr-missing` would still be cleaned up as a success — worktree
  // removed, local branch deleted, and no resume pointer recorded — destroying
  // the state the retry needs to open the PR that is missing.
  return { success, prVerdict: effectivePrVerdict };
}

// Tail of the agent's transcript scanned by the rescue. The deliverable, when
// printed, is the LAST thing the model emits, and a reasoner envelope is a few
// KB at most — but a repaint-heavy TUI spends most of its bytes on escape
// sequences, so the window is generous relative to the payload. Bounded for the
// same reason RAW_TAIL_ANALYSIS_BYTES is: neither transcript file has an upper
// size limit on a long run.
const TRANSCRIPT_RESCUE_TAIL_BYTES = 256 * 1024;

// Transcript spools, in the order the rescue reads them. A PTY/TUI run spools
// its terminal to raw.txt; a direct CLI run (every public-review stage, and any
// cli-typed provider) has ONLY output.txt, so reading raw.txt alone made the
// tool-free Eligibility Gate's printed JSON invisible and a valid decision was
// rejected as eligibility-response-invalid. Each source is tried until one
// yields a payload rather than stopping at the first that merely EXISTS: a
// repaint-heavy raw.txt can interleave the answer past reconstruction while the
// parsed output.txt beside it still holds it intact.
const TRANSCRIPT_RESCUE_FILES = ['raw.txt', 'output.txt'];

/**
 * Recover a programmatic-I/O deliverable the agent PRINTED to its terminal
 * instead of writing to `.agent-done` (#3640). Returns the payload, or null
 * when the type opts out (no shape predicate), the spool is unreadable, or
 * nothing in the transcript matches the hook's expected shape — in which case
 * the caller behaves exactly as it did before this existed.
 *
 * Gated to programmatic-I/O types on purpose: everywhere else the sentinel is a
 * completion SIGNAL rather than the product, and scraping a transcript for one
 * would let an agent that merely discussed finishing be treated as finished.
 */
async function rescueTranscriptPayload({ agentId, taskType }) {
  if (!agentId || !isProgrammaticIoTaskType(taskType)) return null;
  // Sanctioned try/catch (see AGENTS.md — this runs outside the request
  // lifecycle): a best-effort salvage must never be able to make the outcome
  // WORSE than not attempting it. A hook whose own shape predicate throws would
  // otherwise abort the dispatch and skip the hook entirely, turning "we
  // couldn't recover the payload" into "the hook never ran".
  try {
    const isPayload = await getTaskOutputPayloadPredicate(taskType);
    if (!isPayload) return null;
    const { PATHS, readFileTail } = await import('../lib/fileUtils.js');
    const { extractSentinelPayloadFromTranscript } = await import('../lib/agentSentinel.js');
    for (const file of TRANSCRIPT_RESCUE_FILES) {
      const transcript = await readFileTail(join(PATHS.cosAgents, agentId, file), TRANSCRIPT_RESCUE_TAIL_BYTES);
      if (!transcript) continue;
      const { payload } = await extractSentinelPayloadFromTranscript(transcript, isPayload);
      if (payload != null) return payload;
    }
    return null;
  } catch (err) {
    emitLog('warn', `⚠️ Transcript payload rescue failed for ${agentId} (${taskType}): ${err.message}`, { agentId });
    return null;
  }
}

/**
 * Accept a legacy hook payload written directly to the sentinel. The generic
 * sentinel parser intentionally treats an object without `payload` as a plain
 * summary, but older programmatic-I/O prompts (including issue-watcher's first
 * version) told agents to write the hook payload at the top level. Only accept
 * that shape when the task's own predicate confirms it, and never reinterpret a
 * structured envelope or a plain-text summary as a bare payload.
 */
async function recoverBareSentinelPayload(contents, taskType) {
  if (typeof contents !== 'string' || !isProgrammaticIoTaskType(taskType)) return null;
  try {
    const { safeJSONParse } = await import('../lib/fileUtils.js');
    const candidate = safeJSONParse(contents, null, { allowArray: false, logError: false });
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || Object.hasOwn(candidate, 'summary') || Object.hasOwn(candidate, 'payload')) return null;
    const isPayload = await getTaskOutputPayloadPredicate(taskType);
    return typeof isPayload === 'function' && isPayload(candidate) ? candidate : null;
  } catch (err) {
    // This is a completion boundary, outside the Express request lifecycle. A
    // malformed legacy payload must leave the normal missing-payload verdict
    // intact rather than aborting finalization.
    emitLog('warn', `⚠️ Bare sentinel payload recovery failed for ${taskType}: ${err.message}`, { taskType });
    return null;
  }
}

/**
 * Read the finished agent's `.agent-done` payload and run the task type's
 * `processTaskOutput` hook, if it registers one. No-op for the vast majority of
 * task types (no hook). The hook receives `{ appId, success, payload, ... }` and
 * loads its own app/config — finalizeAgent stays domain-agnostic.
 */
async function dispatchTaskOutputHook({ agentId, task, success, workspacePath, readPayload = true, recovery = false }) {
  // Shared resolver with evaluateSuccessCriteria's gate — "runs a hook" and "gets
  // the programmatic-I/O criterion" must stay the same question (#2727).
  const taskType = resolveTaskHookType(task);
  if (!taskType) return { ran: false };
  const { getTaskOutputHook } = await import('./taskTypeHooks.js');
  const hook = await getTaskOutputHook(taskType);
  if (!hook) return { ran: false };

  const cwd = readPayload ? (workspacePath || task?.metadata?.repoPath || null) : null;
  let payload = null;
  if (cwd) {
    const { doneSentinelPath, parseSentinelPayload, salvageSentinelPayload } = await import('../lib/agentSentinel.js');
    const { tryReadFile } = await import('../lib/fileUtils.js');
    // This run's own sentinel (see doneSentinelName) — in a shared workspace a
    // sibling agent's file must not be consumed as this run's deliverable.
    const contents = await tryReadFile(doneSentinelPath(cwd, agentId));
    payload = parseSentinelPayload(contents).payload;
    // A less-capable (often local) reasoner can emit an almost-valid
    // `{ summary, payload }` envelope — ```json-fenced, prose-trailed, or with
    // raw newlines in the markdown body — that strict parse rejects, dropping a
    // real proposal as "unparseable-response" and filing nothing. Before giving
    // up, run the robust LLM-JSON extractor over the raw sentinel.
    if (payload == null) {
      const salvaged = await salvageSentinelPayload(contents);
      if (salvaged.payload != null) {
        payload = salvaged.payload;
        emitLog('info', `Recovered structured .agent-done payload for ${agentId} (${taskType}) via lenient JSON extraction`, { agentId });
      }
    }
    // Compatibility for programmatic-I/O prompts that predate the structured
    // `{ summary, payload }` envelope and wrote the hook payload directly.
    if (payload == null && contents != null) {
      const bare = await recoverBareSentinelPayload(contents, taskType);
      if (bare != null) {
        payload = bare;
        emitLog('info', `Recovered legacy bare .agent-done payload for ${agentId} (${taskType})`, { agentId });
      }
    }
    // No sentinel at all: the model may have PRINTED its deliverable into the
    // TUI instead of writing the file (#3640). `contents == null` — not just a
    // null payload — so a sentinel the agent DID write, whose content simply
    // isn't a payload, keeps its own (correct) missing-output verdict instead of
    // being overridden by something older in the transcript.
    if (payload == null && contents == null) {
      const rescued = await rescueTranscriptPayload({ agentId, taskType });
      if (rescued != null) {
        payload = rescued;
        emitLog('info', `Recovered printed payload for ${agentId} (${taskType}) from the transcript — no .agent-done was written`, { agentId });
      }
    }
  }
  if (recovery && payload == null && !canRunTaskOutputHookWithoutPayload(taskType)) {
    return { ran: false, recoveryPayloadUnavailable: true };
  }

  const outcome = await hook({
    appId: task?.metadata?.app || null,
    success,
    payload,
    workspacePath: cwd,
    agentId,
    task,
  });
  // The outcome's `reason` is what lets finalizeAgent count a "completed" run
  // that produced nothing usable (`unparseable-response`) as a type-level
  // failure (#2616) — an exit-0 run whose structured output couldn't be parsed.
  return { ran: true, outcome };
}

/**
 * Persist task/simplify summaries for agents that ran with /simplify.
 * Shared by handleAgentCompletion (runner mode) and spawnDirectly (direct mode).
 */
export async function persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn) {
  if (!isTruthyMetaFn(task.metadata?.simplify)) return;
  const summaries = extractSimplifySummaries(outputBuffer);
  if (!summaries) return;
  // Persist whenever *either* summary is present — e.g. if the /simplify
  // marker appears at the very top of the output, taskSummary will be null
  // but simplifySummary is still worth keeping.
  if (summaries.taskSummary || summaries.simplifySummary) {
    await updateAgent(agentId, { metadata: {
      taskSummary: summaries.taskSummary || null,
      simplifySummary: summaries.simplifySummary || null
    } });
  }
}
