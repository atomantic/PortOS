/**
 * The programmatic phase of a user-triggered pipeline run, as a renderable plan.
 *
 * A "Run Now" — the scheduled-task Run button, or the PR/MR row's "Review this
 * PR" — does not become an agent task immediately. The request is queued, a
 * drain engine picks it up, and for some task types a deterministic preflight
 * runs BEFORE any agent exists: pr-reviewer lists the app's external PRs and
 * pushes their content through the model-abuse guard (hidden-Unicode and
 * prompt-injection screening) first. Until that finished, the Tasks page had
 * nothing to show and the click read as a no-op (the button said "queued" and
 * the page it linked to was empty).
 *
 * This module owns the SHAPE of that phase — the step list, the reducer that
 * advances it, and the terminal shapes — as pure data so both the writer
 * (services/preflightTaskCard.js, which persists it onto a task card) and the
 * UI render the same thing. It performs no I/O and knows nothing about tasks.
 *
 * A step is never invented by the reporter: every key a caller reports must
 * exist in the plan, so the card cannot drift into claiming work the preflight
 * does not actually do.
 */

export const PREFLIGHT_PHASES = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  DONE: 'done',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

export const PREFLIGHT_STEP_STATUSES = Object.freeze(['pending', 'active', 'done', 'skipped', 'failed']);

const QUEUED_STEP = Object.freeze({ key: 'queued', label: 'Waiting for a free task slot' });
const DISPATCH_STEP = Object.freeze({ key: 'dispatch', label: 'Handing off to the agent' });
const DEFAULT_WORK_STEPS = Object.freeze([
  Object.freeze({ key: 'prepare', label: 'Building the task and its prompt' }),
]);

/**
 * pr-reviewer's preflight, in the order `runPrReviewerSecurityPreflight`
 * actually performs it. The security scan is the step users are waiting on and
 * the one they most need named: it is where contributor diffs are screened for
 * hidden Unicode and prompt injection before any model reads them.
 */
const PR_REVIEWER_WORK_STEPS = Object.freeze([
  Object.freeze({ key: 'cadence', label: 'Checking run cadence and park state' }),
  Object.freeze({ key: 'list-prs', label: 'Listing reviewable open pull requests' }),
  Object.freeze({ key: 'in-flight', label: 'Checking for a review already in flight' }),
  Object.freeze({ key: 'security-scan', label: 'Screening PR content for hidden Unicode and prompt injection' }),
  Object.freeze({ key: 'snapshot', label: 'Recording the screened review inputs' }),
]);

const WORK_STEPS_BY_TASK_TYPE = Object.freeze({
  'pr-reviewer': PR_REVIEWER_WORK_STEPS,
});

export function preflightStepPlan(taskType) {
  const work = WORK_STEPS_BY_TASK_TYPE[taskType] || DEFAULT_WORK_STEPS;
  return [QUEUED_STEP, ...work, DISPATCH_STEP].map((step) => ({ ...step, status: 'pending', detail: null }));
}

/**
 * The initial persisted state. `queued` is already `active`, because the card
 * is created the moment the request is queued — that immediacy is the point.
 */
export function createPreflightState({ requestId, taskType, appId = null, appName = null, targetPullRequest = null } = {}) {
  const steps = preflightStepPlan(taskType);
  steps[0] = { ...steps[0], status: 'active' };
  const startedAt = new Date().toISOString();
  return {
    requestId: requestId || null,
    taskType: taskType || null,
    appId,
    appName,
    targetPullRequest,
    phase: PREFLIGHT_PHASES.QUEUED,
    startedAt,
    updatedAt: startedAt,
    steps,
    outcome: null,
    reason: null,
    note: null,
    resultTaskId: null,
  };
}

const isTerminal = (phase) => [PREFLIGHT_PHASES.DONE, PREFLIGHT_PHASES.FAILED, PREFLIGHT_PHASES.INTERRUPTED].includes(phase);

/**
 * Advance one step. Reporting a step `active` closes every earlier unfinished
 * step as `done`: a preflight that reached step 4 necessarily passed steps 2
 * and 3, and making each of them report twice would put the card's accuracy at
 * the mercy of an early return the reporter forgot about.
 *
 * Returns the SAME object when nothing changed (unknown key, already terminal),
 * so a caller can skip a persist rather than rewrite the task file.
 */
export function applyPreflightStep(preflight, key, { status = 'active', detail = null } = {}) {
  if (!preflight || !Array.isArray(preflight.steps) || isTerminal(preflight.phase)) return preflight;
  if (!PREFLIGHT_STEP_STATUSES.includes(status)) return preflight;
  const index = preflight.steps.findIndex((step) => step.key === key);
  if (index === -1) return preflight;

  const steps = preflight.steps.map((step, i) => {
    if (i < index) return ['pending', 'active'].includes(step.status) ? { ...step, status: 'done' } : step;
    if (i > index) return step;
    return { ...step, status, detail: detail ?? step.detail };
  });
  return {
    ...preflight,
    steps,
    phase: PREFLIGHT_PHASES.PREPARING,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Close the plan out. `outcome` is what happened to the RUN, not to a step:
 *
 *   'handed-off'   → an agent task exists now; `resultTaskId` names it.
 *   'programmatic' → the request was satisfied deterministically; no agent was
 *                    ever needed (the programmatic on-demand handlers).
 *   'nothing-to-do'→ the preflight completed and produced no work (no external
 *                    PRs, already reviewed, parked).
 *   'failed'       → the preflight itself could not complete.
 *   'interrupted'  → the server restarted while it was running.
 *
 * Unreached steps become `skipped` rather than staying `pending`, so a finished
 * card never renders as though it were still working.
 */
export function finalizePreflight(preflight, { outcome, reason = null, note = null, resultTaskId = null } = {}) {
  if (!preflight || !Array.isArray(preflight.steps)) return preflight;
  // Already closed. The first close is the true one: a later generic "the drain
  // produced no task" must not overwrite the specific reason the preflight
  // itself recorded on the way out.
  if (isTerminal(preflight.phase)) return preflight;
  const failed = outcome === 'failed';
  const phase = failed
    ? PREFLIGHT_PHASES.FAILED
    : outcome === 'interrupted' ? PREFLIGHT_PHASES.INTERRUPTED : PREFLIGHT_PHASES.DONE;
  const steps = preflight.steps.map((step) => {
    if (step.status === 'active') return { ...step, status: failed ? 'failed' : 'done', detail: failed ? (reason || step.detail) : step.detail };
    if (step.status === 'pending') return { ...step, status: 'skipped' };
    return step;
  });
  return {
    ...preflight,
    steps,
    phase,
    outcome: outcome || null,
    reason,
    note,
    resultTaskId,
    updatedAt: new Date().toISOString(),
  };
}

/** One line naming where the run is, for the task description and the PR row. */
export function preflightHeadline(preflight) {
  if (!preflight) return null;
  if (preflight.phase === PREFLIGHT_PHASES.FAILED) return preflight.reason ? `Preflight failed: ${preflight.reason}` : 'Preflight failed';
  if (preflight.phase === PREFLIGHT_PHASES.INTERRUPTED) return 'Preflight interrupted by a server restart';
  if (preflight.phase === PREFLIGHT_PHASES.DONE) {
    if (preflight.outcome === 'handed-off') return 'Preflight passed — agent started';
    if (preflight.outcome === 'programmatic') return 'Completed without an agent';
    return 'Preflight found nothing to do';
  }
  const active = preflight.steps?.find((step) => step.status === 'active');
  return active ? active.label : 'Preparing';
}
