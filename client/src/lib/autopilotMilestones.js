/**
 * Autopilot milestone map — fold a run's projected plan plus its live
 * progress snapshot into the ordered rows the Autonomous-mode card renders.
 *
 * The two inputs both come from the server and are never re-derived here:
 *   - `plan` rides the run's `start` frame (server: seriesAutopilot/dryRun.js) —
 *     every step the run expects to take, in resolver order, with its count.
 *   - `progress` rides the `progress` frames and the status route (server:
 *     seriesAutopilot/state.js#noteProgress) — completed counts per step kind,
 *     the step running now, and each gate's latest verification.
 *
 * Pure: no React, no fetching. The point of keeping the fold here is that a run
 * can revisit an earlier step (the foundation gate re-checks after arc repairs)
 * and the plan is a snapshot taken at start, so "which milestone are we on" is
 * a cursor question rather than a running tally — and that rule deserves tests
 * rather than living inline in JSX.
 */

import { clamp } from '../utils/formatters';

// Human labels for each conductor step kind (mirrors the `kind` values
// seriesAutopilot/stepResolver.js can return). Lives here rather than in a
// component because both the milestone map and the panel's live status line
// name the same steps — two copies would drift the moment a step is renamed.
export const AUTOPILOT_STEP_LABELS = Object.freeze({
  unlockLocks: 'Unlocking series records',
  characterFoundation: 'Establishing character foundation',
  generateArc: 'Generating arc',
  repairArcStructure: 'Repairing volume structure',
  generateEpisodes: 'Generating episodes',
  verifyArcSpine: 'Checking arc spine',
  verifyArc: 'Verifying arc',
  foundationGate: 'Judging foundation',
  beatSheet: 'Generating beat sheets',
  beatContinuity: 'Beat continuity',
  textStages: 'Writing prose + scripts',
  scriptVerify: 'Verifying scripts',
  editorialReview: 'Editorial review',
  reverseOutline: 'Refreshing scene segmentation',
  editorialChecks: 'Editorial checks',
  editorialHealthGate: 'Editorial health gate',
  revisionCycle: 'Iterate-to-quality revision',
  canonVerify: 'Checking canon descriptions',
  visualDraft: 'Drafting comic art',
  produceTeaser: 'Producing teaser video',
});

/** Display label for a conductor step kind; falls back to the raw kind. */
export const autopilotStepLabel = (kind) => AUTOPILOT_STEP_LABELS[kind] || kind;

/** A milestone's display state. `blocked` is the step a paused/errored run stopped on. */
export const MILESTONE_STATUS = Object.freeze({
  DONE: 'done',
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
  PENDING: 'pending',
});

const SETTLED = new Set([MILESTONE_STATUS.DONE, MILESTONE_STATUS.SKIPPED]);

// Terminal frame types that mean the run stopped ON a step rather than through it.
const STOPPED_TERMINALS = new Set(['paused', 'error', 'canceled']);

/** Did the run stop mid-plan? Drives both the blocked row and the meter's tone. */
export const isStoppedTerminal = (terminal) => STOPPED_TERMINALS.has(terminal);

// A persisted marker records how the run ENDED as a status, not as the frame
// type the fold reads — so a map rebuilt from the marker (#4140, after a reload
// with no live run) needs the same translation the live panel gets for free from
// the terminal frame. `running` / `idle` map to null: no terminal reached, so
// the step the run was on still reads as active rather than blocked.
const MARKER_TERMINALS = Object.freeze({ done: 'complete', paused: 'paused', error: 'error' });

/** Terminal frame type equivalent to a persisted `autopilot.status`, or null. */
export const autopilotMarkerTerminal = (status) => MARKER_TERMINALS[status] || null;

const countOf = (map, key) => {
  const n = map?.[key];
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Ordered milestone rows for a plan + progress pair.
 *
 * @param {Array<{kind:string,count:number,note?:string,estActions?:number}>} plan
 * @param {{currentStep?:string|null, completed?:Object, skipped?:Object, verified?:Object}} progress
 * @param {{terminal?:string|null}} [opts] terminal frame type of a finished run
 * @returns {Array<{kind,count,done,skipped,note,estActions,status,verification}>}
 */
export function buildAutopilotMilestones(plan, progress = {}, { terminal = null } = {}) {
  const rows = Array.isArray(plan) ? plan : [];
  const completed = progress?.completed || {};
  const skipped = progress?.skipped || {};
  const verified = progress?.verified || {};
  const currentStep = progress?.currentStep || null;
  // `currentStep` survives its own completion (the server keeps it so a run that
  // ends right there can still name the step). This is the flag that says which
  // reading applies — mid-step, or finished and about to move on.
  const currentStepRunning = !!currentStep && progress?.currentStepComplete !== true;
  const stopped = isStoppedTerminal(terminal);
  // How far the run has reached. A revisited earlier step must not un-finish the
  // milestones after it, so the cursor is the FURTHEST index with evidence — the
  // running step, or any step that has completed at least once. Ascending scan,
  // so the last match is the furthest one.
  let cursor = -1;
  rows.forEach((row, i) => {
    if (row?.kind === currentStep || countOf(completed, row?.kind) > 0) cursor = i;
  });

  return rows.map((row, i) => {
    const kind = row?.kind;
    const count = Number.isFinite(row?.count) && row.count > 0 ? row.count : 1;
    const done = countOf(completed, kind);
    let status;
    if (kind === currentStep && stopped) {
      status = MILESTONE_STATUS.BLOCKED;
    } else if (kind === currentStep && currentStepRunning) {
      status = MILESTONE_STATUS.ACTIVE;
    } else if (terminal === 'complete' || i <= cursor) {
      // Settled: the run is past this milestone — either it stepped through it,
      // or (a completed run, or one the cursor has overtaken) the resolver
      // decided against it. Not work still owed either way.
      status = done > 0 ? MILESTONE_STATUS.DONE : MILESTONE_STATUS.SKIPPED;
    } else {
      status = MILESTONE_STATUS.PENDING;
    }
    return {
      kind,
      count,
      done: Math.min(done, count),
      skipped: countOf(skipped, kind),
      note: row?.note || null,
      estActions: Number.isFinite(row?.estActions) ? row.estActions : null,
      status,
      verification: verified[kind] || null,
    };
  });
}

/**
 * Roll milestone rows into the header meter. A settled-but-unstepped milestone
 * (`skipped`) counts as complete — the run is not going back for it, so leaving
 * it out would park the bar short of 100% on a finished run.
 */
export function summarizeAutopilotMilestones(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let total = 0;
  let done = 0;
  for (const row of list) {
    total += row.count;
    done += SETTLED.has(row.status) ? row.count : Math.min(row.done, row.count);
  }
  return {
    total,
    done,
    steps: list.length,
    stepsDone: list.filter((r) => SETTLED.has(r.status)).length,
    percent: total > 0 ? clamp(Math.round((done / total) * 100), 0, 100) : 0,
  };
}

/**
 * One short line for what a gate actually validated, or null when it hasn't run
 * yet. The foundation gate scores rather than counts findings, so it reads
 * differently from every other gate.
 *
 * Shared with the panel's live status line (`frameLabel`): the milestone row and
 * the activity log render the SAME telemetry, a round apart, so two phrasings of
 * it in one card is a drift bug waiting to happen. Both take the raw frame /
 * stored verification — the fields are identical.
 */
export function describeAutopilotVerification(kind, verification) {
  if (!verification) return null;
  if (kind === 'foundationGate') {
    const { weightedScore, threshold, weakest } = verification;
    if (!Number.isFinite(weightedScore)) return null;
    const bar = Number.isFinite(threshold) ? `/${threshold}` : '';
    return `weighted ${weightedScore}${bar}${weakest ? ` · next target: ${weakest}` : ''}`;
  }
  const { findings, blocking, errored } = verification;
  if (!Number.isFinite(findings)) return null;
  const tail = errored > 0 ? ` · ⚠️ ${errored} errored` : '';
  if (!Number.isFinite(blocking)) return `${findings} finding(s)${tail}`;
  return `${blocking} blocking of ${findings} finding(s)${tail}`;
}
