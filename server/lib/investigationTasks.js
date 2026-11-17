/**
 * Investigation tasks — identity, fingerprinting, and the auto-retry decision.
 *
 * Pure helpers shared by the producer (`agentErrorAnalysis.js`), the reaper
 * (`cosTaskStore.js`) and the retry (`services/investigationRetry.js`), which
 * must agree on what an investigation task IS and which failure it tracks.
 */

import { NON_AUTO_RETRY_BLOCK_CATEGORIES } from './taskBlockCategories.js';
import { PR_COMPLETIONS } from './prDisposition.js';

import { isTruthyMeta } from './metadataFlags.js';
export { NON_AUTO_RETRY_BLOCK_CATEGORIES };

// Stable headline every `agentErrorAnalysis` investigation task starts with —
// the one signal present on tasks with the durable `isInvestigation` marker AND
// on older tasks without it (including ones synced from a not-yet-upgraded
// federated peer, which a local migration can't reach).
export const INVESTIGATION_HEADLINE_PREFIX = '[Auto] Investigate agent failure';

// Investigation tasks are unattended code-repair work. Keep them out of the
// checkout that spawned them and send every change through the normal PR gate;
// otherwise the generic commit handoff writes directly to the current branch.
// Top-level task data (not metadata) because producers pass it to addTask().
export const INVESTIGATION_TASK_DELIVERY = Object.freeze({
  // Without this an outage, a quota or an already-merged fix cannot stand down:
  // the commit criterion turns the honest no-change report into a respawn.
  noChangeSuccess: true,
  useWorktree: true,
  openPR: true,
  prCompletion: PR_COMPLETIONS.MERGE_ON_GREEN,
});

// The SUPERVISED posture: same isolation as the unattended one above, but the PR
// waits for a review instead of merging on green, for every investigation where
// somebody WILL look. One literal rather than one per caller so copies can't
// drift when the posture gains a field.
export const SUPERVISED_INVESTIGATION_DELIVERY = Object.freeze({
  // Verification may establish that the reported finding is already resolved.
  noChangeSuccess: true,
  useWorktree: true,
  openPR: true,
  prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
});

// The supervised posture for an investigation a USER queued from the UI; they
// clicked it and are here to look at the fix.
export const CLIENT_INVESTIGATION_DELIVERY = SUPERVISED_INVESTIGATION_DELIVERY;

// `kind` segment reserved for client-queued investigations, keeping them in a
// separate fingerprint namespace so a client can neither collide with nor evict
// an auto-filed investigation's dedup key.
export const CLIENT_INVESTIGATION_KIND = 'ui-investigation';

// Longest subject slug folded into a client fingerprint; the key is compared on
// every dedup scan, so keep it short but distinct per install failure.
const CLIENT_INVESTIGATION_SUBJECT_MAX = 80;

/** Lowercase `a-z0-9-` slug of a free-text subject, bounded. Pure. */
function investigationSubjectSlug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CLIENT_INVESTIGATION_SUBJECT_MAX)
    .replace(/-+$/, '');
}

/**
 * The dedup key for an investigation queued from the UI, derived ENTIRELY from
 * the submitted description/app — never from a client-supplied fingerprint — so
 * repeat clicks on one failure dedup and different failures stay distinct. Pure.
 * `app` narrows the key like an auto-filed `scope`; absent means PortOS itself.
 */
export function clientInvestigationFingerprint({ description, app } = {}) {
  const subject = investigationSubjectSlug(description);
  const appSlug = investigationSubjectSlug(app);
  return investigationFingerprint({
    kind: CLIENT_INVESTIGATION_KIND,
    scope: appSlug ? `${appSlug}/${subject}` : subject,
  });
}

/**
 * Is this task an investigation task? Prefers the durable metadata marker and
 * falls back to the legacy headline shape so investigations persisted before
 * the marker existed are still recognized. Pure.
 */
export function isInvestigationTask(task) {
  if (isTruthyMeta(task?.metadata?.isInvestigation)) return true;
  return typeof task?.description === 'string'
    && task.description.trimStart().startsWith(INVESTIGATION_HEADLINE_PREFIX);
}

/**
 * Durable dedup key: same failure category against the same kind of task in the
 * same app is the same cause. NOT keyed on the free-text message, which varies
 * per run. Pure.
 */
export function buildInvestigationFingerprint(originalTask, analysis) {
  return investigationFingerprint({
    category: analysis?.category,
    kind: originalTask?.metadata?.analysisType
      || originalTask?.metadata?.selfImprovementType
      || originalTask?.taskType,
    scope: originalTask?.metadata?.app
  });
}

/**
 * The `category:kind:scope` key itself, for producers with no originating CoS
 * task (an AI-provider outage, an uncaught server exception). One builder keeps
 * every producer's key in the format the dedup scan recognizes. Pure.
 */
export function investigationFingerprint({ category, kind, scope } = {}) {
  return `${category || 'unknown'}:${kind || 'task'}:${scope || 'none'}`;
}

/**
 * One reading of what `fileInvestigationTask` just did, in the shape a caller
 * reports to a user. A task the loop policy HELD is not a queued one, and a
 * duplicate FOLD is a usable outcome rather than a failure; a deliberate
 * suppression must not be reported as "could not be queued".
 *
 * Pure, and here rather than beside the producer, so a suite that doubles the
 * filing side still reads the real interpretation. `subject` names the thing in
 * the refusal sentence and is the only per-caller part.
 */
export function investigationOutcome(filed, { subject = 'the investigation task' } = {}) {
  if (!filed?.task) {
    return {
      queued: false,
      loopReason: filed?.loopReason || null,
      reason: filed?.loopReason
        ? `${subject} was suppressed (${filed.loopReason})`
        : `${subject} could not be queued`,
    };
  }
  return {
    queued: true,
    taskId: filed.task.id,
    approvalRequired: filed.approvalRequired === true,
    duplicate: filed.task.duplicate === true,
    loopReason: filed.loopReason || null,
  };
}

// ===== Approval policy =====

/**
 * Rolling circuit breaker across ALL fingerprints, mirroring `autoFixer.js`'s
 * `tripCircuit`: at most {@link INVESTIGATION_CIRCUIT_MAX_CREATIONS}
 * investigation tasks per window. A systemic storm fails MANY distinct tasks at
 * once, each minting its own fingerprint, so per-fingerprint dedup can't stop
 * the fan-out. The window is rolling, so the circuit auto-closes.
 */
export const INVESTIGATION_CIRCUIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const INVESTIGATION_CIRCUIT_MAX_CREATIONS = 3;

/**
 * How recently a PRIOR investigation of the same cause must have finished for a
 * fresh failure to count as a LOOP rather than an unrelated recurrence (the
 * fingerprint is coarse, so a months-later repeat is new work). Wider than the
 * circuit window on purpose: the circuit measures a storm in progress, this
 * measures "we already tried and it came back".
 */
export const INVESTIGATION_LOOP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * How many investigations already filed inside the circuit window make the NEXT
 * one a storm rather than ordinary traffic: the last slot before the circuit
 * stops filing tasks. A couple of unrelated failures an hour is normal and must
 * stay unattended. The `max(1, …)` floor keeps a cap of 1 from making the
 * threshold 0, which would hold EVERY investigation.
 */
export const INVESTIGATION_STORM_HOLD_THRESHOLD = Math.max(1, INVESTIGATION_CIRCUIT_MAX_CREATIONS - 1);

/**
 * Namespace for the loop reason stamped as the generic
 * `metadata.approvalReason`, so it can't collide with other producers' reasons
 * in one flat namespace. The client's `TaskItem.jsx` renders a hint per token.
 */
export const INVESTIGATION_APPROVAL_REASON_PREFIX = 'investigation-loop:';

/**
 * Human-facing prose for each loop reason, rendered into the task body. Counts
 * are interpolated from the constants above so it can't drift from them.
 */
export const LOOP_REASON_PROSE = {
  'repeat-fingerprint': `This exact failure cause was already investigated within the last ${INVESTIGATION_LOOP_WINDOW_MS / (60 * 60 * 1000)} hours and it has come back — the previous fix did not hold, so this one is held for you instead of spawning another unattended agent that would repeat it.`,
  'failure-storm': `${INVESTIGATION_STORM_HOLD_THRESHOLD} other agent failure(s) were already filed for investigation this hour, one slot short of the circuit breaker suppressing them entirely — failures are cascading rather than isolated, so this one is held for you rather than spending another unattended agent on a symptom.`
};

/**
 * Did a genuine investigation of this fingerprint already finish inside the loop
 * window? `auto-expired` completions don't count: the reaper
 * (`sweepResolvedFailureTasks`) flips those because their origin tasks went
 * away, so nothing was attempted. Pure.
 */
function priorInvestigationSettledRecently(tasks, fingerprint, now) {
  return tasks.some((t) => {
    if (t.status !== 'completed') return false;
    if (t.metadata?.investigationFingerprint !== fingerprint) return false;
    if (t.metadata?.resolution === 'auto-expired') return false;
    const settledAt = Date.parse(t.metadata?.updatedAt);
    // An undated completion can't be proved recent; treat it as old.
    if (!Number.isFinite(settledAt)) return false;
    return now - settledAt < INVESTIGATION_LOOP_WINDOW_MS;
  });
}

/**
 * Approval policy for a new investigation task.
 *
 * The DEFAULT is auto-approved and unattended: CoS diagnoses its own failures.
 * Human approval is reserved for a failure LOOP, where another unattended agent
 * would just repeat what already didn't work:
 *
 *  - `repeat-fingerprint` — we investigated this exact cause within the last
 *    {@link INVESTIGATION_LOOP_WINDOW_MS} and it is back.
 *  - `failure-storm` — the circuit window is already at
 *    {@link INVESTIGATION_STORM_HOLD_THRESHOLD} investigations (failures
 *    cascading rather than isolated).
 *
 * Pure — every input is injected.
 *
 * @param {{ fingerprint: string, tasks: object[], recentCreations?: number, now?: number }} args
 * @returns {{ approvalRequired: boolean, loopReason: 'repeat-fingerprint'|'failure-storm'|null,
 *   approvalReason: string|null, loopProse: string|null }}
 */
export function resolveInvestigationApproval({
  fingerprint,
  tasks = [],
  recentCreations = 0,
  now = Date.now()
} = {}) {
  if (priorInvestigationSettledRecently(tasks, fingerprint, now)) return approvalVerdict('repeat-fingerprint');
  if (recentCreations >= INVESTIGATION_STORM_HOLD_THRESHOLD) return approvalVerdict('failure-storm');
  return approvalVerdict(null);
}

/** The full verdict for one loop reason (`null` = unattended). Pure. */
function approvalVerdict(loopReason) {
  return {
    approvalRequired: !!loopReason,
    loopReason,
    approvalReason: loopReason ? `${INVESTIGATION_APPROVAL_REASON_PREFIX}${loopReason}` : null,
    loopProse: loopReason ? LOOP_REASON_PROSE[loopReason] : null
  };
}

/** The unattended verdict a failed policy read falls open to. Pure. */
export const UNATTENDED_APPROVAL_VERDICT = Object.freeze(approvalVerdict(null));

/**
 * Whether the explicit CoS auto-approval override admits a pending
 * investigation. Intentionally narrow: never changes ordinary task approval or
 * bypasses the autonomy/budget gates.
 */
export function isAutoApprovableInvestigation(task, config) {
  return config?.autoApproveInvestigations === true
    && isInvestigationTask(task)
    && task?.status === 'pending'
    && task?.approvalRequired === true;
}

// ===== Auto-retry of the tasks an investigation was blocking =====

/**
 * How many times ONE task may be auto-revived off a completed investigation
 * before it stays blocked for a human. This bounds the investigate → retry →
 * fail → investigate loop and is independent of `MAX_TASK_RETRIES`: a revive
 * resets the per-attempt failure budget, so a separate counter that survives
 * the reset is the only ceiling. Two covers a fix plus a follow-up; a third
 * means the investigations are not converging.
 */
export const MAX_AUTO_RETRIES_PER_TASK = 2;

/** Why a named affected task was NOT auto-retried (surfaced in the log line). */
export const RETRY_SKIP_REASONS = {
  GONE: 'gone',
  NOT_BLOCKED: 'not-blocked',
  BLOCK_NOT_AUTO_RETRYABLE: 'block-not-auto-retryable',
  BUDGET_EXHAUSTED: 'auto-retry-budget-exhausted',
};

/** Auto-retries a task has already been granted. Survives the markdown round-trip. */
export function autoRetryCount(task) {
  const n = Number(task?.metadata?.autoRetryCount);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Could this task release anything, judged from the task alone? The pre-read
 * gate for {@link resolveInvestigationRetryTargets}, so most completions skip
 * reading both task files.
 *
 * The `auto-expired` exclusion is the non-obvious one: the reaper flips
 * investigations to `completed` when their origin tasks went away, a cleanup
 * rather than a fix, and each flip would otherwise cost a full both-queue read.
 * Pure.
 */
export function couldReleaseBlockedTasks(investigation) {
  return isInvestigationTask(investigation)
    && investigation.status === 'completed'
    && !isTruthyMeta(investigation.metadata?.preserveOriginalBudget)
    && investigation.metadata?.resolution !== 'auto-expired'
    && affectedTaskIds(investigation).length > 0;
}

/**
 * The task ids an investigation names, deduped so a repeat id (later
 * same-fingerprint failures union into one investigation) can't double-count a
 * task's auto-retry budget. Pure.
 */
export function affectedTaskIds(investigation) {
  const affected = investigation?.metadata?.affectedTasks;
  return Array.isArray(affected) ? [...new Set(affected)] : [];
}

/**
 * Which tasks does a just-finished investigation release back into the queue?
 *
 * Pure — the caller supplies the investigation and an id→task index. Returns the
 * targets to revive and every deliberately skipped task with its reason.
 * Re-checks {@link couldReleaseBlockedTasks} so a direct caller can't skip it.
 *
 * @param {{ investigation: object, tasksById: Map<string, object> }} args
 * @returns {{ targets: object[], skipped: Array<{ taskId: string, reason: string }> }}
 */
export function resolveInvestigationRetryTargets({ investigation, tasksById } = {}) {
  if (!couldReleaseBlockedTasks(investigation)) return { targets: [], skipped: [] };

  const targets = [];
  const skipped = [];
  for (const taskId of affectedTaskIds(investigation)) {
    const task = tasksById?.get(taskId);
    if (!task) {
      skipped.push({ taskId, reason: RETRY_SKIP_REASONS.GONE });
    } else if (task.status !== 'blocked') {
      // Whatever already settled the task wins over this revive.
      skipped.push({ taskId, reason: RETRY_SKIP_REASONS.NOT_BLOCKED });
    } else if (NON_AUTO_RETRY_BLOCK_CATEGORIES.has(task.metadata?.blockedCategory)) {
      skipped.push({ taskId, reason: RETRY_SKIP_REASONS.BLOCK_NOT_AUTO_RETRYABLE });
    } else if (autoRetryCount(task) >= MAX_AUTO_RETRIES_PER_TASK) {
      skipped.push({ taskId, reason: RETRY_SKIP_REASONS.BUDGET_EXHAUSTED });
    } else {
      targets.push(task);
    }
  }
  return { targets, skipped };
}

/** Metadata patch for `reviveBlockedTask`; see {@link MAX_AUTO_RETRIES_PER_TASK}. Pure. */
export function autoRetryMetadata(task, investigationId, now = Date.now()) {
  return {
    autoRetryCount: autoRetryCount(task) + 1,
    autoRetriedByInvestigation: investigationId,
    autoRetriedAt: new Date(now).toISOString(),
  };
}
