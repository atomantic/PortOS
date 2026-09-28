/**
 * Music Video — opt-in automatic review/retries (#8988, part of #8966): pure
 * record transforms.
 *
 * An auto-review RUN is a persisted checkpoint on the project
 * (`project.autoReviews[]`) that exists only because the director explicitly
 * started one, with their own limits:
 *
 *   - `limits.maxAttempts`    — how many drafts may be REVIEWED (each review is
 *                               one provider call; the counter is spent before
 *                               the call, so a crash mid-call still counts it);
 *   - `limits.maxGenerations` — the spend limit: how many paid scene-generation
 *                               jobs the run's revisions may put on the queue.
 *                               Charged at the enqueue choke point
 *                               (`chargeAutoReviewGeneration`, called from the
 *                               generation routes' revision guard) so a job over
 *                               the limit is refused BEFORE it is paid for.
 *
 * Each attempt renders the draft window (free), reviews it, and either passes
 * the run or files the review's timecoded findings as flagged notes on that
 * excerpt and opens a #8987 selective revision for the sections they land in.
 * The revision's re-rendered draft is the next attempt's excerpt. Everything a
 * later step needs is derived from the record (`nextAutoReviewStep`), so a
 * stopped or interrupted run resumes exactly where it was: an attempt that
 * already holds a review is never reviewed again, and a revised section that
 * already holds a take is never generated again (#8987 semantics).
 *
 * No boot or standing job ever advances a run — only the director's start /
 * resume and the completion events of work that run itself put in flight.
 *
 * Peer sync: `autoReviews` is an additive field on the whole-record LWW
 * project body (same posture as `excerpts`/`revisions`). An older peer stores
 * it verbatim and has no route that acts on it, so no schema bump is needed.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { addExcerptNote, projectExcerpts } from './excerpt.js';
import { projectRevisions } from './revision.js';

export const AUTO_REVIEW_LIMIT_BOUNDS = Object.freeze({
  maxAttempts: Object.freeze({ min: 1, max: 10 }),
  maxGenerations: Object.freeze({ min: 0, max: 100 }),
});
// Statuses: `running` (advancing), `stopped` (paused by the director —
// resumable), `limit-reached` (a limit stopped it — resumable once raised),
// and the terminal `passed` / `needs-human` / `failed` / `canceled`.
export const AUTO_REVIEW_STATUSES = Object.freeze(['running', 'stopped', 'limit-reached', 'passed', 'needs-human', 'failed', 'canceled']);
const RESUMABLE = new Set(['running', 'stopped', 'limit-reached']);
const ACTIVE = new Set(['running', 'stopped', 'limit-reached']);
export const AUTO_REVIEW_CHECKS = Object.freeze(['composition', 'continuity', 'motion', 'audioSync']);
// Draft renders are free, but a window that fails to render every time must
// not loop forever: this many failed renders of one attempt fail the run.
export const MAX_RENDER_FAILURES = 2;
const MAX_PROJECT_AUTO_REVIEWS = 10;
const MAX_FINDINGS = 20;
const MAX_FINDING_LEN = 500;
const NOTE_PREFIX = '[auto-review]';

const autoReviewError = (status, code, message, context) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

/** The run array on a project, tolerating a legacy record with none. */
export const projectAutoReviews = (project) => (Array.isArray(project?.autoReviews) ? project.autoReviews : []);

/** The run that is still live (running, paused, or waiting on raised limits), if any. */
export const activeAutoReview = (project) => projectAutoReviews(project).find((r) => ACTIVE.has(r.status)) || null;

const currentAttempt = (run) => run.attempts[run.attempts.length - 1];

function findRun(project, runId) {
  const run = projectAutoReviews(project).find((r) => r.id === runId);
  if (!run) throw autoReviewError(404, 'NOT_FOUND', 'Auto-review run not found');
  return run;
}

function replaceRun(project, run) {
  return { ...project, autoReviews: projectAutoReviews(project).map((r) => (r.id === run.id ? run : r)) };
}

function pruneRuns(runs) {
  const next = runs.slice();
  for (let i = 0; i < next.length && next.length > MAX_PROJECT_AUTO_REVIEWS;) {
    if (ACTIVE.has(next[i].status)) i += 1;
    else next.splice(i, 1);
  }
  return next;
}

const intIn = (value, { min, max }, name) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw autoReviewError(422, 'VALIDATION_ERROR', `${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
};

/** Validate a limits object; every limit is REQUIRED — a run never picks its own budget. */
export function normalizeAutoReviewLimits(limits) {
  return {
    maxAttempts: intIn(limits?.maxAttempts, AUTO_REVIEW_LIMIT_BOUNDS.maxAttempts, 'maxAttempts'),
    maxGenerations: intIn(limits?.maxGenerations, AUTO_REVIEW_LIMIT_BOUNDS.maxGenerations, 'maxGenerations'),
  };
}

const touchRun = (run, patch, now) => ({ ...run, ...patch, updatedAt: now });

/**
 * Start a run over `[startSec, endSec)`. Refuses while another run is live or
 * a manual revision is open (the run needs the revision slot for its own).
 */
export function startAutoReviewOnProject(project, { startSec, endSec, limits, reviewer = {} }, now = new Date().toISOString()) {
  const live = activeAutoReview(project);
  if (live) throw autoReviewError(409, 'AUTO_REVIEW_IN_PROGRESS', 'Finish, cancel or resume the existing auto-review run first', { runId: live.id });
  const openRevision = projectRevisions(project).find((r) => r.status === 'open' || r.status === 'rendering');
  if (openRevision) throw autoReviewError(409, 'REVISION_IN_PROGRESS', 'Finish or cancel the open revision before starting an auto-review run', { revisionId: openRevision.id });
  if (!(startSec >= 0) || !(endSec > startSec)) throw autoReviewError(422, 'INVALID_EXCERPT_RANGE', 'endSec must be greater than startSec');
  const run = {
    id: `mvar-${randomUUID()}`,
    status: 'running',
    startSec,
    endSec,
    limits: normalizeAutoReviewLimits(limits),
    reviewer: {
      providerId: isNonBlankStr(reviewer.providerId) ? reviewer.providerId : null,
      model: isNonBlankStr(reviewer.model) ? reviewer.model : null,
    },
    usage: { reviews: 0, generations: 0 },
    attempts: [{ n: 1, excerptId: null, renderFailures: 0, reviewStartedAt: null, review: null, revisionId: null }],
    stopReason: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return { project: { ...project, autoReviews: pruneRuns([...projectAutoReviews(project), run]), updatedAt: now }, run };
}

/**
 * Pure: what the run should do next, derived from the record alone:
 *   `render`  — the attempt has no draft yet (or its draft failed and may retry);
 *   `review`  — the attempt's draft is ready and unreviewed (and the attempt
 *               budget allows another review);
 *   `revise`  — the review asked for changes and no revision was opened yet;
 *   `resume-revision` — the attempt's revision is open (generate or re-render);
 *   `next-attempt`    — the revision's re-rendered draft is ready to review;
 *   `wait`    — a render is in flight;
 *   `halt`    — the run must stop now (`status` + `reason`);
 *   `idle`    — the run is not running.
 */
export function nextAutoReviewStep(project, run) {
  if (run.status !== 'running') return { type: 'idle' };
  const attempt = currentAttempt(run);
  if (!attempt.excerptId) return { type: 'render' };
  const excerpt = projectExcerpts(project).find((e) => e.id === attempt.excerptId);
  const renderFailed = !excerpt || excerpt.status === 'error' || excerpt.status === 'canceled';
  if (renderFailed && !attempt.review) {
    if (attempt.renderFailures >= MAX_RENDER_FAILURES) {
      return { type: 'halt', status: 'failed', reason: `The draft failed to render ${attempt.renderFailures + 1} times${excerpt?.error ? `: ${excerpt.error}` : ''}` };
    }
    return { type: 'render', retry: true };
  }
  if (excerpt?.status === 'rendering') return { type: 'wait', on: 'render', excerptId: excerpt.id };
  if (!attempt.review) {
    if (run.usage.reviews >= run.limits.maxAttempts) {
      return { type: 'halt', status: 'limit-reached', reason: `Reached the ${run.limits.maxAttempts}-review attempt limit` };
    }
    return { type: 'review', excerptId: attempt.excerptId };
  }
  if (!attempt.revisionId) return { type: 'revise', excerptId: attempt.excerptId };
  const revision = projectRevisions(project).find((r) => r.id === attempt.revisionId);
  if (!revision || revision.status === 'canceled') {
    return { type: 'halt', status: 'needs-human', reason: 'The run\'s revision was cancelled — review this draft by hand' };
  }
  if (revision.status === 'rendering') return { type: 'wait', on: 'render', excerptId: revision.renderExcerptId };
  if (revision.status === 'open') {
    // A revised draft that keeps failing to render must not re-render forever.
    if (revision.error && (revision.renderAttempts || 0) > MAX_RENDER_FAILURES) {
      return { type: 'halt', status: 'failed', reason: `The revised draft failed to render ${revision.renderAttempts} times: ${revision.error}` };
    }
    return { type: 'resume-revision', revisionId: revision.id };
  }
  return { type: 'next-attempt', excerptId: revision.renderExcerptId };
}

function mutateRun(project, runId, fn, now) {
  const run = findRun(project, runId);
  const next = fn(run);
  return { project: replaceRun(project, touchRun(run, next, now)), run: touchRun(run, next, now) };
}

const withAttempt = (run, patch) => ({
  attempts: run.attempts.map((a, i) => (i === run.attempts.length - 1 ? { ...a, ...patch } : a)),
});

/** Link the current attempt to a draft render it just started (a retry counts the failed one). */
export function attachAttemptExcerpt(project, runId, excerptId, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => {
    const attempt = currentAttempt(run);
    const failed = attempt.excerptId ? 1 : 0;
    return withAttempt(run, { excerptId, renderFailures: attempt.renderFailures + failed });
  }, now);
}

/** Open the next attempt on the revision's re-rendered draft. */
export function beginNextAttempt(project, runId, excerptId, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => ({
    attempts: [...run.attempts, { n: run.attempts.length + 1, excerptId, renderFailures: 0, reviewStartedAt: null, review: null, revisionId: null }],
  }), now);
}

/**
 * Spend one review from the attempt budget BEFORE the provider call. Throws
 * 409 when the budget is spent, the run is no longer running, or the attempt
 * already holds a review — so an overlapping advance can never pay twice.
 */
export function beginAttemptReview(project, runId, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => {
    if (run.status !== 'running') throw autoReviewError(409, 'AUTO_REVIEW_NOT_RUNNING', `This run is ${run.status}`);
    const attempt = currentAttempt(run);
    if (attempt.review) throw autoReviewError(409, 'ATTEMPT_ALREADY_REVIEWED', 'This draft was already reviewed');
    if (run.usage.reviews >= run.limits.maxAttempts) {
      throw autoReviewError(409, 'AUTO_REVIEW_ATTEMPT_LIMIT', `Reached the ${run.limits.maxAttempts}-review attempt limit`);
    }
    return { usage: { ...run.usage, reviews: run.usage.reviews + 1 }, ...withAttempt(run, { reviewStartedAt: now }) };
  }, now);
}

const cleanFinding = (f, spanSec) => {
  if (!f || typeof f !== 'object' || !isNonBlankStr(f.note)) return null;
  const atSec = typeof f.atSec === 'number' && Number.isFinite(f.atSec) ? Math.min(Math.max(0, f.atSec), spanSec) : null;
  if (atSec === null) return null;
  return {
    atSec: Math.round(atSec * 1000) / 1000,
    note: trimTo(f.note, MAX_FINDING_LEN),
    severity: f.severity === 'minor' ? 'minor' : 'blocking',
    check: AUTO_REVIEW_CHECKS.includes(f.check) ? f.check : null,
    source: f.source === 'analysis' ? 'analysis' : 'reviewer',
  };
};

/**
 * Record a gated review (see `gateAutoReview` in autoReviewJudge.js) on the
 * current attempt. `pass` ends the run `passed`; `inconclusive` ends it
 * `needs-human` (a frame-only look can never pass motion/audio sync); `revise`
 * files every blocking finding as a flagged, timecoded note on the draft so
 * the #8987 revision rejects exactly the sections they land in.
 */
export function recordAttemptReview(project, runId, review, now = new Date().toISOString()) {
  const run = findRun(project, runId);
  const attempt = currentAttempt(run);
  if (attempt.review) throw autoReviewError(409, 'ATTEMPT_ALREADY_REVIEWED', 'This draft was already reviewed');
  const excerpt = projectExcerpts(project).find((e) => e.id === attempt.excerptId);
  const spanSec = excerpt ? excerpt.endSec - excerpt.startSec : 0;
  const findings = (Array.isArray(review.findings) ? review.findings : []).map((f) => cleanFinding(f, spanSec)).filter(Boolean).slice(0, MAX_FINDINGS);
  const stored = { ...review, findings, reviewedAt: now };
  let next = project;
  if (review.verdict === 'revise' && excerpt) {
    for (const finding of findings.filter((f) => f.severity === 'blocking')) {
      next = addExcerptNote(next, excerpt.id, { atSec: finding.atSec, note: `${NOTE_PREFIX} ${finding.note}`, verdict: 'flagged' }, now).project;
    }
  }
  const terminal = review.verdict === 'pass'
    ? { status: 'passed', stopReason: null }
    : review.verdict === 'inconclusive'
      ? { status: 'needs-human', stopReason: review.reason || 'The review could not verify every check — a director must watch this draft' }
      : {};
  const updated = touchRun(run, { ...terminal, ...withAttempt(run, { review: stored }) }, now);
  return { project: replaceRun(next, updated), run: updated };
}

/** Link the attempt's revision (opened in the same write, see autoReviewService). */
export function attachAttemptRevision(project, runId, revisionId, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => withAttempt(run, { revisionId }), now);
}

/** Stop the run with a status/reason (a `halt` step, or a failed step). */
export function haltAutoReview(project, runId, { status, reason = null, error = null }, now = new Date().toISOString()) {
  if (!AUTO_REVIEW_STATUSES.includes(status) || status === 'running') throw new Error(`haltAutoReview: invalid status ${status}`);
  return mutateRun(project, runId, (run) => {
    if (!RESUMABLE.has(run.status)) throw autoReviewError(409, 'AUTO_REVIEW_CLOSED', `This run is already ${run.status}`);
    return { status, stopReason: reason, error };
  }, now);
}

/** Director pause: nothing new is handed out; resumable from the same checkpoint. */
export function stopAutoReviewOnProject(project, runId, now = new Date().toISOString()) {
  const run = findRun(project, runId);
  if (run.status !== 'running') throw autoReviewError(409, 'AUTO_REVIEW_NOT_RUNNING', `This run is ${run.status}`);
  return haltAutoReview(project, runId, { status: 'stopped', reason: 'Stopped by the director' }, now);
}

/**
 * Resume a stopped (or limit-reached) run from its checkpoint. `limits`
 * optionally RAISES the budget — never below what the run already spent.
 */
export function resumeAutoReviewOnProject(project, runId, { limits } = {}, now = new Date().toISOString()) {
  return mutateRun(project, runId, (run) => {
    if (!RESUMABLE.has(run.status)) throw autoReviewError(409, 'AUTO_REVIEW_CLOSED', `This run is ${run.status} — start a new run instead`);
    const nextLimits = limits ? normalizeAutoReviewLimits({ ...run.limits, ...limits }) : run.limits;
    if (nextLimits.maxAttempts < run.usage.reviews || nextLimits.maxGenerations < run.usage.generations) {
      throw autoReviewError(422, 'VALIDATION_ERROR', 'A limit cannot be lowered below what this run already used');
    }
    return { status: 'running', limits: nextLimits, stopReason: null, error: null };
  }, now);
}

/** Cancel (terminal). Returns the open revision the caller must cancel too, if any. */
export function cancelAutoReviewOnProject(project, runId, now = new Date().toISOString()) {
  const run = findRun(project, runId);
  if (!RESUMABLE.has(run.status)) throw autoReviewError(409, 'AUTO_REVIEW_CLOSED', `This run is already ${run.status}`);
  const revisionId = currentAttempt(run).revisionId;
  const revision = revisionId ? projectRevisions(project).find((r) => r.id === revisionId) : null;
  const out = haltAutoReview(project, runId, { status: 'canceled', reason: 'Cancelled by the director' }, now);
  return { ...out, revisionId: revision && (revision.status === 'open' || revision.status === 'rendering') ? revision.id : null };
}

/**
 * The spend check at the enqueue choke point: a generation job tagged with a
 * revision that a RUNNING run opened is charged against the run's
 * `maxGenerations`, and refused (409 AUTO_REVIEW_SPEND_LIMIT) once it is spent
 * — before the job is queued. A revision no running run owns (a manual one, or
 * a paused run the director is finishing by hand) is not charged.
 * Returns `{ project, run }` — `run` null (and the project untouched) when no
 * running run owns the revision.
 */
export function chargeAutoReviewGeneration(project, revisionId, now = new Date().toISOString()) {
  const run = runOwningRevision(project, revisionId);
  if (!run) return { project, run: null };
  if (run.usage.generations >= run.limits.maxGenerations) {
    throw autoReviewError(409, 'AUTO_REVIEW_SPEND_LIMIT', `This auto-review run reached its ${run.limits.maxGenerations}-generation spend limit`, { runId: run.id });
  }
  return mutateRun(project, run.id, (r) => ({ usage: { ...r.usage, generations: r.usage.generations + 1 } }), now);
}

/** Generations still affordable before the spend limit. */
export const remainingGenerations = (run) => Math.max(0, run.limits.maxGenerations - run.usage.generations);

/**
 * The running run (if any) waiting on this excerpt's render: its current
 * attempt's own draft, or the re-render of its current attempt's revision.
 */
export function runAwaitingExcerpt(project, excerptId) {
  const revisions = projectRevisions(project);
  return projectAutoReviews(project).find((run) => {
    if (run.status !== 'running') return false;
    const attempt = currentAttempt(run);
    return attempt.excerptId === excerptId
      || (!!attempt.revisionId && revisions.some((r) => r.id === attempt.revisionId && r.renderExcerptId === excerptId));
  }) || null;
}

/** The running run (if any) whose current attempt's revision is this one. */
export const runOwningRevision = (project, revisionId) => projectAutoReviews(project)
  .find((run) => run.status === 'running' && currentAttempt(run).revisionId === revisionId) || null;
