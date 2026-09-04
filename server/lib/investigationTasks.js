/**
 * Investigation tasks — identity, fingerprinting, and the auto-retry decision.
 *
 * Pure helpers shared by the three parties that all have to agree on what an
 * investigation task IS and which failure it tracks: the producer
 * (`agentErrorAnalysis.js`), the reaper (`cosTaskStore.js`, which used to
 * hand-copy the predicate to dodge a `cosTaskStore ↔ cos.js ↔
 * agentErrorAnalysis` import cycle), and the retry
 * (`services/investigationRetry.js`, which owns the why).
 */

import { NON_AUTO_RETRY_BLOCK_CATEGORIES } from './taskBlockCategories.js';
import { PR_COMPLETIONS } from './prDisposition.js';

export { NON_AUTO_RETRY_BLOCK_CATEGORIES };

// Stable headline every investigation task created by `agentErrorAnalysis` has
// ever started with — the one signal present on BOTH tasks carrying the durable
// `isInvestigation` marker and pre-#2615 tasks that predate it (including tasks
// synced from a not-yet-upgraded federated peer, which a local migration can't
// reach).
export const INVESTIGATION_HEADLINE_PREFIX = '[Auto] Investigate agent failure';

// Investigation tasks are unattended code-repair work. Keep them out of the
// checkout that spawned them and send every change through the normal PR gate;
// otherwise the generic commit handoff writes directly to the current branch.
// This is top-level task data (rather than nested metadata) because both the
// shared producer and the agent-failure producer pass it to addTask().
export const INVESTIGATION_TASK_DELIVERY = Object.freeze({
  useWorktree: true,
  openPR: true,
  prCompletion: PR_COMPLETIONS.MERGE_ON_GREEN,
});

// Delivery for an investigation a USER queued from the UI (#6043) — the
// installer-failure "Queue agent to investigate" button today. Same isolation as
// the unattended posture above, but the PR waits for a review instead of merging
// on green: `merge-on-green` exists because an auto-filed investigation has
// nobody watching it, and that reason is gone the moment a human clicked the
// button. They are here to look at the fix, so let them.
export const CLIENT_INVESTIGATION_DELIVERY = Object.freeze({
  useWorktree: true,
  openPR: true,
  prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
});

// `kind` segment reserved for client-queued investigations. Auto-filed keys take
// their kind from an analysis/self-improvement/task type, so this value keeps the
// two populations in separate fingerprint namespaces: a client can neither
// collide with an auto-filed investigation's dedup key nor evict it.
export const CLIENT_INVESTIGATION_KIND = 'ui-investigation';

// Longest subject slug folded into a client fingerprint. The key is stored on
// every matching task and compared on every dedup scan, so it stays short enough
// to read in a log line while keeping distinct install failures distinct.
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
 * what the client submitted — never from a client-supplied fingerprint. Two
 * clicks on the same failing installer produce the same key (so the queued task
 * participates in dedup and the loop policy), while a different failure produces
 * a different one. Pure.
 *
 * `app` narrows the key the way an auto-filed key's `scope` segment does; absent
 * — the install button's case — means PortOS itself.
 */
export function clientInvestigationFingerprint({ description, app } = {}) {
  const subject = investigationSubjectSlug(description);
  const appSlug = investigationSubjectSlug(app);
  return investigationFingerprint({
    kind: CLIENT_INVESTIGATION_KIND,
    scope: appSlug ? `${appSlug}/${subject}` : subject,
  });
}

// Task metadata survives a markdown round-trip, so booleans come back as the
// strings 'true'/'false'. Local to keep this module import-free of the services
// layer, where the generic `isTruthyMeta` lives.
const truthyMeta = (value) => value === true || value === 'true';

/**
 * Is this task an investigation task? Prefers the durable metadata marker and
 * falls back to the legacy headline shape so investigations persisted before
 * the marker existed are still recognized. Pure.
 */
export function isInvestigationTask(task) {
  if (truthyMeta(task?.metadata?.isInvestigation)) return true;
  return typeof task?.description === 'string'
    && task.description.trimStart().startsWith(INVESTIGATION_HEADLINE_PREFIX);
}

/**
 * Durable dedup key for investigation tasks: same failure category against the
 * same kind of task in the same app is the same cause. Deliberately NOT keyed
 * on the free-text failure message — for `unknown`-category failures that is a
 * raw agent-output line that varies per run, which is exactly the dedup hole
 * that let near-identical investigations pile up (#2615). Pure.
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
 * The `category:kind:scope` key itself, for producers whose failure has no
 * originating CoS task to derive one from (an AI-provider outage, an uncaught
 * server exception). Same three-segment shape, built by the same function, so a
 * change to the format can't leave those producers writing a key the dedup scan
 * no longer recognizes. Pure.
 */
export function investigationFingerprint({ category, kind, scope } = {}) {
  return `${category || 'unknown'}:${kind || 'task'}:${scope || 'none'}`;
}

// ===== Approval policy (#3714) =====

/**
 * Rolling circuit breaker across ALL fingerprints, mirroring `autoFixer.js`'s
 * `tripCircuit`: at most {@link INVESTIGATION_CIRCUIT_MAX_CREATIONS}
 * investigation tasks per window. A systemic failure storm (provider outage,
 * broken spawn path) fails MANY distinct tasks at once, each minting a distinct
 * fingerprint — the per-fingerprint dedup alone can't stop that fan-out. The
 * window is rolling, so the circuit auto-closes as creations age out.
 */
export const INVESTIGATION_CIRCUIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const INVESTIGATION_CIRCUIT_MAX_CREATIONS = 3;

/**
 * How recently a PRIOR investigation of the same cause must have finished for a
 * fresh failure to count as a LOOP rather than an unrelated recurrence. The same
 * fingerprint tripping again months later is new work (fingerprints are coarse —
 * `category:kind:scope`, deliberately not keyed on the message); the same
 * fingerprint tripping again the day after we investigated it means the last
 * investigation did not hold, and burning another unattended agent on it just
 * spins. Wider than the circuit window on purpose: the circuit measures a storm
 * in progress, this measures "we already tried and it came back".
 */
export const INVESTIGATION_LOOP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * How many investigations already filed inside the circuit window make the NEXT
 * one a storm rather than ordinary traffic. Derived from the circuit cap, not a
 * magic number: the last slot before the circuit stops filing tasks at all is
 * the one worth a human. A couple of unrelated agent failures in an hour is
 * normal on a busy install and must stay unattended — otherwise this gate
 * re-creates the stall it exists to remove. The `max(1, …)` floor keeps a
 * hypothetical cap of 1 from making the threshold 0, which would hold EVERY
 * investigation — the exact inversion of this policy.
 */
export const INVESTIGATION_STORM_HOLD_THRESHOLD = Math.max(1, INVESTIGATION_CIRCUIT_MAX_CREATIONS - 1);

/**
 * Namespace for the loop reason when stamped as the task's generic
 * `metadata.approvalReason` — the shared "why is this waiting on me?" key any
 * approval-required producer can write (cosTaskGenerator computes the same
 * concept for its safety-kind / confidence holds). Prefixing keeps this
 * vocabulary from colliding with theirs in one flat namespace. The client's
 * `TaskItem.jsx` renders a hint per token.
 */
export const INVESTIGATION_APPROVAL_REASON_PREFIX = 'investigation-loop:';

/**
 * Human-facing prose for each loop reason, rendered into the task body so the
 * user reading the queue knows WHY this one stopped for them when the previous
 * investigation did not. Counts are interpolated from the constants above so the
 * prose can't drift from the thresholds it describes.
 */
export const LOOP_REASON_PROSE = {
  'repeat-fingerprint': `This exact failure cause was already investigated within the last ${INVESTIGATION_LOOP_WINDOW_MS / (60 * 60 * 1000)} hours and it has come back — the previous fix did not hold, so this one is held for you instead of spawning another unattended agent that would repeat it.`,
  'failure-storm': `${INVESTIGATION_STORM_HOLD_THRESHOLD} other agent failure(s) were already filed for investigation this hour, one slot short of the circuit breaker suppressing them entirely — failures are cascading rather than isolated, so this one is held for you rather than spending another unattended agent on a symptom.`
};

/**
 * Did a genuine investigation of this fingerprint already finish inside the loop
 * window? `auto-expired` completions don't count — the reaper flips those to
 * `completed` because their origin tasks went away (cosTaskStore's
 * `sweepResolvedFailureTasks`), so nothing was ever actually attempted and
 * holding the next one for a human would punish a cleanup, not a loop. Pure.
 */
function priorInvestigationSettledRecently(tasks, fingerprint, now) {
  return tasks.some((t) => {
    if (t.status !== 'completed') return false;
    if (t.metadata?.investigationFingerprint !== fingerprint) return false;
    if (t.metadata?.resolution === 'auto-expired') return false;
    const settledAt = Date.parse(t.metadata?.updatedAt);
    // An undated completion can't be proved recent — treat it as old, so the
    // default stays "auto-approve" rather than silently gating on a legacy task.
    if (!Number.isFinite(settledAt)) return false;
    return now - settledAt < INVESTIGATION_LOOP_WINDOW_MS;
  });
}

/**
 * Approval policy for a new investigation task.
 *
 * An agent failure is ordinary, expected traffic: the whole point of an
 * investigation task is that CoS diagnoses its own failures without a human in
 * the loop, so the DEFAULT is auto-approved and unattended. Human approval is
 * reserved for a failure LOOP — the two shapes where letting another agent run
 * unattended would just repeat what already didn't work:
 *
 *  - `repeat-fingerprint` — we investigated this exact cause within the last
 *    {@link INVESTIGATION_LOOP_WINDOW_MS} and it is back.
 *  - `failure-storm` — the circuit window is already at
 *    {@link INVESTIGATION_STORM_HOLD_THRESHOLD} investigations, i.e. failures
 *    are cascading rather than isolated. (One slot later the circuit stops
 *    filing tasks at all; this is the last one before that ceiling.)
 *
 * Pure — every input is injected so the branching is unit-testable.
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

/** The neutral, unattended verdict — what a failed policy read falls open to. Pure. */
export const UNATTENDED_APPROVAL_VERDICT = Object.freeze(approvalVerdict(null));

/**
 * Whether a pending investigation should be admitted by the explicit CoS
 * auto-approval override. The override is intentionally narrow: it never
 * changes ordinary task approval or bypasses the CoS autonomy/budget gates.
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
 * before it stays blocked for a human. This is the outer bound on the
 * investigate → retry → fail → investigate loop, and it is deliberately
 * independent of `MAX_TASK_RETRIES`: a revive resets the per-attempt failure
 * budget (that is what makes it a real retry), so without a separate counter
 * that survives the reset the loop would have no ceiling at all.
 *
 * Two is the useful number. The first auto-retry covers the common case — the
 * investigation found a config/env cause, fixed it, and the task now runs. A
 * second covers a fix that needed a follow-up. A third would mean the
 * investigations are not converging, which is a human's problem.
 */
export const MAX_AUTO_RETRIES_PER_TASK = 2;

/**
 * Why a named affected task was NOT auto-retried. Surfaced in the log line so a
 * "why didn't my task come back?" question is answerable from the journal alone.
 */
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
 * Could this task release anything, judged from the task alone? The whole
 * pre-read gate for {@link resolveInvestigationRetryTargets}, so the caller can
 * skip reading both task files for a completion that can't possibly revive
 * something — which is most of them, since every task completion on the install
 * reaches the retry.
 *
 * The `auto-expired` exclusion is the non-obvious one: the reaper flips
 * investigations to `completed` when their origin tasks went away
 * (`sweepResolvedFailureTasks`, up to 50 per sweep), so that completion is a
 * cleanup, not a fix — and without this guard each of those 50 flips would cost
 * a full both-queue read to discover it releases nothing. Pure.
 */
export function couldReleaseBlockedTasks(investigation) {
  return isInvestigationTask(investigation)
    && investigation.status === 'completed'
    && investigation.metadata?.resolution !== 'auto-expired'
    && affectedTaskIds(investigation).length > 0;
}

/**
 * The task ids an investigation names, deduped — later same-fingerprint failures
 * union their id into the surviving investigation, and a repeat there must not
 * double-count a task's auto-retry budget. Pure.
 */
export function affectedTaskIds(investigation) {
  const affected = investigation?.metadata?.affectedTasks;
  return Array.isArray(affected) ? [...new Set(affected)] : [];
}

/**
 * Which tasks does a just-finished investigation release back into the queue?
 *
 * Pure — the caller supplies the investigation and an id→task index. Returns the
 * targets to revive and, separately, every affected task that was deliberately
 * skipped with the reason why. Assumes {@link couldReleaseBlockedTasks} already
 * passed, and re-checks it so a direct caller can't skip the gate.
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
      // Already completed, already running, or already back in the queue —
      // whatever settled it wins over this revive.
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

/**
 * The metadata patch handed to `reviveBlockedTask` for one auto-retried task.
 * `autoRetryCount` is the budget that survives the revive's own clearing of
 * `failureCount` — see {@link MAX_AUTO_RETRIES_PER_TASK}. Pure.
 */
export function autoRetryMetadata(task, investigationId, now = Date.now()) {
  return {
    autoRetryCount: autoRetryCount(task) + 1,
    autoRetriedByInvestigation: investigationId,
    autoRetriedAt: new Date(now).toISOString(),
  };
}
