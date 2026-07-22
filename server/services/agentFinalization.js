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
import { emitLog } from './cosEvents.js';
import { updateAgent, completeAgent } from './cosAgents.js';
import { updateTask } from './cos.js';
import { getActiveProvider } from './providers.js';
import { markProviderUsageLimit, markProviderRateLimited } from './providerStatus.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { resolveFailedTaskUpdate, resolveTypeFailureSignal } from './agentErrorAnalysis.js';
import { completeAgentRun, checkForTaskCommit } from './agentRunTracking.js';
import { isProgrammaticIoTaskType, resolveTaskHookType, isNonCommittingCoordinatorTask } from './taskTypeHooks.js';
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
  if (isNonCommittingCoordinatorTask(task)) return null;
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
  success,
  exitCode,
  duration,
  outputBuffer,
  errorAnalysis,
  terminatedByUser = false,
  isTruthyMetaFn,
  error,
  completionReason,
  workspacePath = null,
}) {
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
  const hookResult = await withOutputHookTimeout(
    dispatchTaskOutputHook({ agentId, task, success, workspacePath }),
    { agentId }
  ).catch(err => {
    emitLog('error', `❌ processTaskOutput hook threw for ${agentId} (${task?.taskType}): ${err.message}`, { agentId, error: err.message });
    // A thrown hook is a non-success signal for the type ledger (#2616) and a
    // rejected success criterion for task-learning (#2727).
    return { ran: true, threw: true };
  });

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
  await completeAgent(agentId, {
    success,
    validationPassed,
    exitCode,
    duration,
    outputLength: outputBuffer?.length ?? 0,
    errorAnalysis,
    ...(error !== undefined ? { error } : {}),
    ...(completionReason !== undefined ? { completionReason } : {}),
  });

  if (runId) {
    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis);
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
async function dispatchTaskOutputHook({ agentId, task, success, workspacePath }) {
  // Shared resolver with evaluateSuccessCriteria's gate — "runs a hook" and "gets
  // the programmatic-I/O criterion" must stay the same question (#2727).
  const taskType = resolveTaskHookType(task);
  if (!taskType) return { ran: false };
  const { getTaskOutputHook } = await import('./taskTypeHooks.js');
  const hook = await getTaskOutputHook(taskType);
  if (!hook) return { ran: false };

  const cwd = workspacePath || task?.metadata?.repoPath || null;
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
