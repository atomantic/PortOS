/** Approve held tasks, record challenges, and resolve disputes through arbitration or a reviewer recheck. */
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { reviewerModelsFromDefaults } from '../../lib/reviewerConfig.js';
import { hasActiveTaskOwner } from '../agent/agentState.js';
import { runLocalCodeReview, getCodeReviewDefaults } from '../codeReview.js';
import { canChallenge, getChallengeCount, buildChallengePatch, buildChallengeResolutionPatch, classifyRecheckOutcome, MAX_CHALLENGES_PER_TASK } from './cosChallenge.js';
import { cosEvents } from './cosEvents.js';
import { loadState, withStateLock } from './cosState.js';
import { getTaskById } from './cosTaskViews.js';
import { readTaskFile, writeTaskList } from './cosTaskWorkingSet.js';

/**
 * Approve a task that requires approval (marks it as auto-approved).
 *
 * Emits `tasks:changed` with `action: 'approved'`; cos.js's init listener
 * fires `dequeueNextTask` off that so the newly approved task can spawn
 * immediately.
 */
export async function approveTask(taskId, { now = Date.now() } = {}) {
  return withStateLock(async () => {
    // Both queues, internal first. A USER row can hold too: a row the parser had
    // to RECOVER is withheld from the unattended spawn and now persists that hold
    // as `| APPROVAL |` (#7300, #7367). Without a release path here that row is a
    // zombie — pending forever, with nothing in the product able to clear it —
    // which is a worse outcome than the evaporating hold it replaced.
    let found = null;
    for (const taskType of ['internal', 'user']) {
      const tasks = await readTaskFile(taskType);
      const taskIndex = tasks.findIndex(t => t.id === taskId);
      if (taskIndex !== -1) {
        found = { taskType, tasks, taskIndex };
        break;
      }
    }

    if (!found) {
      return { error: 'Task not found' };
    }

    const { taskType, tasks, taskIndex } = found;

    if (!tasks[taskIndex].approvalRequired) {
      return { error: 'Task does not require approval' };
    }

    // Update approval flags. Approval is editable content (the merge's
    // contentSignature counts the approval flags), so bump the `updatedAt` LWW
    // stamp (#1714) too — otherwise an approval on one peer would lose a same-status
    // tie to a stale edit on the other instead of winning as the newest edit.
    tasks[taskIndex] = {
      ...tasks[taskIndex],
      approvalRequired: false,
      autoApproved: true,
      metadata: { ...tasks[taskIndex].metadata, updatedAt: new Date(now).toISOString() }
    };

    await writeTaskList(taskType, tasks);

    cosEvents.emit('tasks:changed', { type: taskType, action: 'approved', task: tasks[taskIndex] });

    const { removeByMetadata } = await import('../notifications.js');
    await removeByMetadata('taskId', taskId).catch(() => {});

    return tasks[taskIndex];
  });
}

// Challenge decisions and writes must share the same non-reentrant state lock.
// The store supplies its lock-held update and its ordinary escalation-task intake.
export function createTaskChallenges({ addTask, writeTaskUpdateLocked }) {
  /**
   * Record a sub-agent's challenge of a reviewer rejection (#2441).
   *
   * Parks the task in the `challenged` status with the worker's case attached and
   * consumes one of its bounded challenge slots (MAX_CHALLENGES_PER_TASK). A second
   * dispute on the same task is refused — the acceptance contract is "exactly one
   * per task." Read, budget check, and write share the completion/state lock.
   *
   * @returns the updated task, or `{ error, code }` on not-found / budget-exhausted.
   */
  async function challengeTask(taskId, { reason, evidence, reviewer } = {}, taskType = 'user', { now = Date.now() } = {}) {
    return withStateLock(async () => {
      const task = await getTaskById(taskId);
      if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
      const resolvedType = task.taskType || taskType;
      // A challenge disputes a REJECTION of in-flight work — never a finished task.
      // Parking a `completed` task in `challenged` would also regress it out of a
      // terminal state (a completed task never re-completes), so refuse it outright.
      if (task.status === 'completed') {
        return { error: 'Cannot challenge a completed task', code: 'CANNOT_CHALLENGE_COMPLETED' };
      }
      // Bounded by BOTH the one-shot dispute cap AND the shared retry budget (#2471) —
      // a challenge that overturns re-queues the task, so refuse one that's already out
      // of total spawns (it would only get re-blocked by agentLifecycle's spawn gate).
      if (!canChallenge(task.metadata, { maxTotalSpawns: MAX_TOTAL_SPAWNS })) {
        const spawns = Number(task.metadata?.totalSpawnCount) || 0;
        const budgetExhausted = spawns >= MAX_TOTAL_SPAWNS;
        return {
          error: budgetExhausted
            ? `Retry budget exhausted (${spawns}/${MAX_TOTAL_SPAWNS} spawns) — cannot challenge a task out of retries`
            : `Challenge budget exhausted (${getChallengeCount(task.metadata)}/${MAX_CHALLENGES_PER_TASK} used)`,
          code: budgetExhausted ? 'CHALLENGE_BUDGET_EXHAUSTED' : 'CHALLENGE_EXHAUSTED',
        };
      }
      const patch = buildChallengePatch(task.metadata, { reason, evidence, reviewer, now });
      const updated = await writeTaskUpdateLocked(taskId, { status: 'challenged', metadata: patch }, resolvedType, { now });
      if (updated?.error) return updated;
      console.log(`⚖️ Task ${taskId} challenged (${patch.challengeCount}/${MAX_CHALLENGES_PER_TASK})${patch.challenge.reviewer ? ` — disputing ${patch.challenge.reviewer}` : ''}`);
      return updated;
    });
  }

  /**
   * Resolve a parked challenge (#2441). `upheld` overturns the rejection and
   * preserves its active owner (→ in_progress), or requeues an unowned task
   * (→ pending); `escalated` hands the unresolved dispute to
   * the user — the task is blocked with a challenge-escalation reason AND an
   * approval-required arbitration task is filed into COS-TASKS.md (reusing the same
   * investigation/escalation surface `createInvestigationTask` writes to), so a
   * sustained disagreement surfaces to the user rather than silently fixing or
   * quietly blocking.
   *
   * @returns the updated task, or `{ error, code }` on not-found / not-challenged /
   *          invalid-outcome.
   */
  async function resolveTaskChallenge(taskId, { outcome, note, resolvedBy } = {}, taskType = 'user', { now = Date.now() } = {}) {
    const resolution = await withStateLock(async () => {
      const task = await getTaskById(taskId);
      if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
      if (task.status !== 'challenged') {
        return { error: 'Task is not under challenge', code: 'NOT_CHALLENGED' };
      }
      const resolvedType = task.taskType || taskType;
      const resolutionPatch = buildChallengeResolutionPatch({ outcome, note, resolvedBy, now });
      if (!resolutionPatch) return { error: `Invalid challenge outcome: ${outcome}`, code: 'INVALID_OUTCOME' };

      const state = await loadState();
      const nextStatus = outcome === 'upheld'
        ? (hasActiveTaskOwner(taskId, state.agents) ? 'in_progress' : 'pending')
        : 'blocked';
      const metadataPatch = { ...resolutionPatch };
      if (outcome === 'escalated') {
        metadataPatch.blockedReason = 'Challenge unresolved — escalated to user for arbitration';
        metadataPatch.blockedCategory = 'challenge-escalation';
      }
      const updated = await writeTaskUpdateLocked(taskId, { status: nextStatus, metadata: metadataPatch }, resolvedType, { now });
      if (updated?.error) return updated;
      return { task, updated, nextStatus, resolvedType };
    });
    if (resolution.error) return resolution;
    const { task, updated, nextStatus } = resolution;

    if (outcome === 'escalated') {
      // Surface the dispute to the single PortOS user as an approval-required
      // arbitration task (mirrors createInvestigationTask's escalation surface).
      // Best-effort: a failed escalation-task write must not fail the resolution
      // itself (the original task is already blocked with the reason attached).
      const caseReason = task.metadata?.challenge?.reason || '(no reason recorded)';
      const disputedReviewer = task.metadata?.challenge?.reviewer;
      const escalationDescription = `[Challenge] Arbitrate disputed rejection on ${taskId}`;
      const escalationContext = [
        `A sub-agent challenged a reviewer rejection on task ${taskId} and the dispute is unresolved.`,
        disputedReviewer ? `Disputed reviewer: ${disputedReviewer}` : null,
        `Worker's case: ${caseReason}`,
        note ? `Resolver note: ${note}` : null,
        'Decide: approve to overturn the rejection, or delete to let the rejection stand.',
      ].filter(Boolean).join('\n');
      await addTask({
        description: escalationDescription,
        priority: 'HIGH',
        context: escalationContext,
        approvalRequired: true,
      }, 'internal', { now }).catch((err) => {
        console.error(`❌ Failed to file challenge-escalation task for ${taskId}: ${err.message}`);
      });
    }

    console.log(`⚖️ Task ${taskId} challenge resolved: ${outcome} → ${nextStatus}`);
    return updated;
  }

  /**
   * Resolve a parked challenge by AUTOMATIC reviewer re-check (#2471). Instead of a
   * human verdict, re-run the disputed (or a second) local-LLM reviewer against the
   * current diff and derive the outcome from its fresh findings — a blocking finding
   * that survives sustains the rejection (→ escalated); nothing blocking overturns it
   * (→ upheld). This is the cheap confirm/overturn pass that runs BEFORE falling back
   * to user escalation, closing the gap #2470 left ("this slice resolves manually").
   *
   * Only the in-process local reviewers (`LOCAL_LLM_REVIEWERS`) are re-run here; CLI
   * reviewers are re-run by the follow-up agent itself, which then calls the manual
   * `resolveTaskChallenge` path with an explicit outcome.
   *
   * @returns the updated task, or `{ error, code }` on not-found / not-challenged /
   *          RECHECK_FAILED (reviewer unreachable or no usable findings).
   */
  async function resolveTaskChallengeWithRecheck(taskId, { recheck, resolvedBy } = {}, taskType = 'user', { now = Date.now() } = {}) {
    const task = await getTaskById(taskId);
    if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
    if (task.status !== 'challenged') {
      return { error: 'Task is not under challenge', code: 'NOT_CHALLENGED' };
    }
    const backend = recheck?.backend;
    // Model: explicit override wins, else the Code Review Defaults for this backend.
    // Effort has no per-request override (a re-check re-runs the SAME reviewer
    // configuration, it doesn't reconfigure it), so it always comes from the
    // defaults — but it must come from somewhere: this verdict decides whether a
    // disputed rejection is upheld or escalated to the user, and deriving it from a
    // pass run at a weaker effort than the user configured is the same silent
    // downgrade the pin exists to prevent.
    // Read straight off the picked defaults: `pickCodeReviewDefaults` already ran
    // every `<reviewer>Effort` scalar through `reviewerEffortsFromDefaults`, so a
    // stale level is null by the time it reaches here — same as the model read below.
    const recheckDefaults = await getCodeReviewDefaults().catch(() => null);
    const effort = recheckDefaults?.[`${backend}Effort`] || null;
    // Keyed off the roster's `<reviewer>Model` scalar rather than a per-backend
    // branch (matching `POST /api/code-review/local`): the old ollama-or-lmstudio
    // ternary read LM STUDIO's model for any third local backend, so an `mtplx`
    // re-check ran against a model id from the wrong daemon.
    //
    // An unset scalar is no longer fatal here: `runLocalCodeReview` falls back to the
    // model the backend is actually serving when that answer is unambiguous, so a
    // single-model daemon re-checks without one. It reports `code: 'NO_MODEL'` when it
    // could not resolve one either, which stays a config problem (4xx) rather than the
    // 502 bucket reserved for a reviewer that's actually unreachable.
    const model = recheck?.model || reviewerModelsFromDefaults(recheckDefaults)[backend] || null;
    console.log(`⚖️ Re-checking challenge on ${taskId} via ${backend} (${model || 'model from the backend'}${effort ? `, ${effort} effort` : ''})`);
    const review = await runLocalCodeReview({ backend, model, effort, diff: recheck?.diff });
    if (!review?.ok) {
      if (review?.code === 'NO_MODEL') return { error: review.error, code: 'RECHECK_NO_MODEL' };
      return { error: `Re-check failed: ${review?.error || 'unknown reviewer error'}`, code: 'RECHECK_FAILED' };
    }
    const outcome = classifyRecheckOutcome(review.findings);
    if (!outcome) {
      return { error: 'Re-check returned no usable findings', code: 'RECHECK_FAILED' };
    }
    const verdict = outcome === 'upheld'
      ? `no findings requiring resolution survived (${backend})`
      : `a finding still requires resolution (${backend})`;
    // The resolution note is auto-generated from the re-check verdict (any caller
    // `note` is intentionally not threaded here — the machine verdict is the record).
    // `review.model` rather than `model`: the reviewer resolves an unpinned id from
    // what the backend is serving, and the record has to name the model that actually
    // produced this verdict, not `null`.
    const note = `Auto re-check by ${backend} (${review.model || model}): ${verdict}.`;
    return resolveTaskChallenge(taskId, { outcome, note, resolvedBy: resolvedBy || `recheck:${backend}` }, taskType, { now });
  }

  return { challengeTask, resolveTaskChallenge, resolveTaskChallengeWithRecheck };
}
