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
import { emitLog } from './cosEvents.js';
import { getAgent, updateAgent, completeAgent } from './cosAgents.js';
import { updateTask } from './cos.js';
import { getActiveProvider } from './providers.js';
import { markProviderUsageLimit, markProviderRateLimited } from './providerStatus.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { resolveFailedTaskUpdate, resolveTypeFailureSignal } from './agentErrorAnalysis.js';
import { completeAgentRun, checkForTaskCommit } from './agentRunTracking.js';
import { canRunTaskOutputHookWithoutPayload, isProgrammaticIoTaskType, resolveTaskHookType, declaresNoCommitCriterion } from './taskTypeHooks.js';
import { processAgentCompletion } from './agentCompletion.js';
import { extractSimplifySummaries } from './agentSummaryExtraction.js';

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
 * machine-checkable criterion the CoS already relies on — a `[task-<id>]` commit.
 *
 * Returns a null sentinel when NO criterion is declared (interactive/user tasks,
 * user-terminated runs, or a run with no task id / workspace to validate
 * against), so downstream telemetry never conflates "not declared" with
 * "declared and failed". For autonomous tasks it verifies the commit on BOTH
 * success and failure — a clean exit that committed nothing is an honest miss,
 * and that is exactly the signal task-learning wants. `checkForTaskCommit` is
 * git-repo-gated, off the event loop, and hard-timeout-bounded, so a non-repo
 * workspace or a hung git degrades to "no commit" rather than stalling finalize.
 *
 * `hookResult` is the programmatic-I/O output-hook result (from
 * `dispatchTaskOutputHook`), which finalizeAgent resolves BEFORE calling this so
 * those task types can be judged by their real deliverable; `success` is the
 * runner's exit-code verdict that hook result is weighed against. Both are
 * absent/null for every other task shape.
 */
export async function evaluateSuccessCriteria({ task, terminatedByUser, workspacePath, success = false, hookResult = null }) {
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
  // the `[task-<id>]` commit check would mark every correct run a failure (#2700).
  // Judging them purely by exit code instead is also wrong: an exit-0 run whose
  // `.agent-done` sentinel was missing/malformed, or whose hook threw, produced
  // nothing usable and must be recorded as the failure it is (#2727).
  if (isProgrammaticIoTaskType(scheduledType)) {
    return resolveProgrammaticIoVerdict({ success, hookResult });
  }
  // Interactive/user tasks declare no machine-checkable criterion; neither does
  // a run missing the task id or workspace needed to validate.
  if (taskType === 'user' || !task?.id || !workspacePath) return null;
  // Pipeline/media tasks deliver artifacts, not a `[task-<id>]` commit — the
  // commit criterion doesn't apply, so don't mislabel a clean artifact run as a
  // validation miss (which would also pollute the correlation window). null =
  // no commit criterion declared for this task shape. Unlike programmatic-I/O
  // tasks they register no output hook, so there is no deliverable signal to
  // judge them by — they stay exit-code-judged (unchanged by #2727).
  if (task?.metadata?.pipeline || task?.metadata?.mediaJob) return null;
  // gh/git/external COORDINATOR task types (NON_COMMITTING_COORDINATOR_TASK_TYPES in
  // taskTypeHooks.js — branch-reconcile/issue-reconcile/branch-cleanup/jira-status-report)
  // deliver their work as a side effect — a merged PR, a resolved conflict, a deleted
  // branch, a posted report — and by design NEVER produce a `[task-<id>]` commit. Because
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
  return await checkForTaskCommit(task.id, workspacePath);
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
 * Sentinel discipline throughout — three distinct answers, never collapsed:
 *   - `false` — the hook ran and REJECTED the output (threw, or `unparseable-response`).
 *   - `null`  — NOTHING evaluated the output (no hook ran, it timed out, or it
 *     returned no structured outcome), so no criterion was declared and
 *     task-learning falls back to the exit code exactly as before. "Not evaluated"
 *     must never become "accepted".
 *   - `true`  — the hook ran and accepted the output.
 *
 * @returns {boolean|null} true = accepted, false = rejected, null = undeclared
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
  // mid-run, or the task carries no app). Nothing evaluated the agent's work — and
  // these paths don't even record a run — so this is "undeclared", not a free
  // success for the type.
  if (HOOK_ABORTED_BEFORE_EVALUATION.has(hookResult.outcome.reason)) return null;
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
 * Three outcomes, never collapsed:
 *   - `ok: true`  — a PR exists, or there was nothing to check
 *   - `ok: false, category: 'pr-missing'` — the forge answered: no PR
 *   - `ok: false, category: 'forge-unreachable'` — we could not ask
 *
 * @returns {Promise<{ ok: boolean, category?: string, message?: string, branch?: string|null }>}
 */
export async function verifyPrClaim({ task, workspacePath, success, prExpected }) {
  // Only a run that CLAIMED success has a claim to verify; a failed run is
  // already recorded as failed.
  if (!prExpected || !success || !workspacePath) return { ok: true };
  const branch = await resolveWorkspaceBranch(workspacePath);
  if (!branch) {
    // No branch to ask about (detached HEAD, non-repo workspace). Nothing was
    // verified — say nothing rather than invent a failure.
    return { ok: true, branch: null };
  }
  const { findPullRequestForBranch } = await import('./github.js');
  const found = await findPullRequestForBranch(branch, { cwd: workspacePath });
  if (found.status === 'found') return { ok: true, branch };
  if (found.status === 'none') {
    return {
      ok: false,
      branch,
      category: PR_MISSING_CATEGORY,
      message: `Agent reported success but no pull request exists for branch ${branch}`
    };
  }
  return {
    ok: false,
    branch,
    category: FORGE_UNREACHABLE_CATEGORY,
    message: `Could not confirm a pull request for branch ${branch} — the forge is unreachable${found.detail ? ` (${String(found.detail).split('\n')[0].slice(0, 120)})` : ''}`
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
      ? `The branch ${verdict.branch} is pushed but has no pull request. Re-run the task, or open the PR by hand with \`gh pr create --head ${verdict.branch}\`.`
      : 'Check the forge probe on the System Health page — `gh` could not reach the forge, so the run\'s PR could not be confirmed.'
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
}) {
  // #3358: a run whose task shape promised a PR is not successful until the
  // forge confirms one exists. Runs BEFORE the completion verdict is derived so
  // every downstream write (task status, learning telemetry, the "Completed
  // successfully" the UI renders off `result.success`) sees the corrected value.
  // A THROW here is not a verdict — fall back to the reported outcome rather
  // than manufacturing a failure out of a check that never ran.
  const prVerdict = terminatedByUser
    ? { ok: true }
    : await verifyPrClaim({ task, workspacePath, success: reportedSuccess, prExpected })
      .catch(err => {
        emitLog('warn', `⚠️ PR verification failed for ${agentId}: ${err.message}`, { agentId });
        return { ok: true };
      });

  const success = reportedSuccess && prVerdict.ok;
  const errorAnalysis = prVerdict.ok ? reportedErrorAnalysis : prVerificationAnalysis(prVerdict);
  if (!prVerdict.ok) {
    emitLog('warn', `⚠️ ${prVerdict.message} — recording ${agentId} as needs-attention (${prVerdict.category}) rather than complete`, {
      agentId, taskId: task?.id, branch: prVerdict.branch, category: prVerdict.category
    });
  }

  if (success && isTruthyMetaFn) {
    await persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn);
  }

  const taskType = task?.taskType || 'user';
  const taskUpdate = terminatedByUser
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

  // Success-criteria validation (issue #2344): stamp an explicit pass/fail (or
  // null-when-undeclared) verdict onto the completion result, distinct from the
  // exit-code `success`, so task-learning telemetry can distinguish "ran clean
  // but produced nothing" from a genuine success. Best-effort — a validation
  // check failure must never block finalize (falls back to the null sentinel).
  const validationPassed = await evaluateSuccessCriteria({ task, terminatedByUser, workspacePath, success, hookResult })
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
  const finalError = prVerdict.ok ? error : prVerdict.message;
  const finalCompletionReason = prVerdict.ok ? completionReason : prVerdict.category;

  await completeAgent(agentId, {
    success,
    validationPassed,
    exitCode,
    duration,
    outputLength: outputBuffer?.length ?? 0,
    errorAnalysis,
    ...(finalError !== undefined ? { error: finalError } : {}),
    ...(finalCompletionReason !== undefined ? { completionReason: finalCompletionReason } : {}),
  });

  if (runId) {
    // Pass the downgrade explicitly: this run exited 0, so the run record would
    // otherwise keep saying "success" for the one run we just concluded did not
    // land its PR (#3358).
    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis, prVerdict.ok ? null : false);
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
    // Lazy provider lookup — only resolve the active provider when a marker
    // fires AND the caller didn't already know the id. This keeps the
    // successful-completion hot path free of a settings-file read.
    const markerProviderId = errorAnalysis.category === 'usage-limit' || errorAnalysis.category === 'rate-limit'
      ? providerId || (await getActiveProvider())?.id
      : null;
    if (markerProviderId && errorAnalysis.category === 'usage-limit' && errorAnalysis.requiresFallback) {
      await markProviderUsageLimit(markerProviderId, errorAnalysis).catch(err => {
        emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId: markerProviderId });
      });
    }
    if (markerProviderId && errorAnalysis.category === 'rate-limit') {
      await markProviderRateLimited(markerProviderId).catch(err => {
        emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId: markerProviderId });
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
    const { DONE_SENTINEL_NAME, parseSentinelPayload, salvageSentinelPayload } = await import('../lib/agentSentinel.js');
    const { tryReadFile } = await import('../lib/fileUtils.js');
    const contents = await tryReadFile(join(cwd, DONE_SENTINEL_NAME));
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
