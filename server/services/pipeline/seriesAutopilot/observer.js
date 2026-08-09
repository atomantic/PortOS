/**
 * Series Autopilot — observing orchestrator (opt-in, continuous pipeline
 * improvement).
 *
 * The sibling of `selfImprove.js` with a stronger contract. Self-improve is a
 * ONE-shot post-mortem whose filed task waits in the human approval queue; the
 * observer WATCHES the run as it progresses — after each step whose fresh
 * telemetry says the automation misbehaved (a retried child, a skipped step, an
 * editorial check that threw, a filed gap) it spends one diagnosis call asking
 * what in PortOS should change, and files that change as an AUTO-APPROVED CoS
 * task: worktree-isolated, PR-opening, review-loop-then-merge, no human gate.
 * The goal is that an unattended autopilot run continuously hardens its own
 * pipeline — a defect noticed at step 4 is being fixed while steps 5–16 run —
 * instead of every run re-hitting the same weakness until someone reads the
 * post-mortems. Its mandate is deliberately broad: step ordering, missing
 * steps, editorial checks, stage prompts, gates/config, even missing UI
 * options are all in scope (see the `pipeline-observer` stage prompt).
 *
 * Why auto-approval is acceptable HERE when every other autonomously generated
 * code-editing task in PortOS hard-codes `approvalRequired: true`: this option
 * is the user explicitly opting into unattended pipeline self-repair — the
 * checkbox copy says the filed work PRs and merges on its own. The remaining
 * guards are structural, not procedural: the cos autonomy domain must be
 * `execute`, every pass is billed against and gated on the daily cos budget,
 * the run caps its passes (OBSERVER_MAX_MIDRUN_PASSES + one terminal), the
 * confidence bar is HIGHER than self-improve's (no human reads the brief before
 * an agent acts on it), the agent works in a worktree and lands through the
 * full PR review loop, and cosTaskStore's first-line dedup collapses repeat
 * diagnoses across steps, runs and series onto one open task.
 *
 * When both options are enabled the observer SUPERSEDES the self-improve
 * terminal diagnosis (see orchestrator.js#postMortem) — same evidence, stronger
 * action policy; running both would double-bill one run's telemetry and file
 * near-duplicate tasks under different dedup keys. The vocabulary, shape, and
 * task/prompt frames shared with the post-mortem live in `diagnosisCore.js`.
 *
 * PRIVACY: identical contract to selfImprove.js — the prompt asks for a defect
 * report about PortOS's code, never the story, and every shaped field is
 * bounded, because the filed task is read by a coding agent that opens a
 * public PR. Manuscript text must not travel into that task.
 */

import * as cosTaskStore from '../../cosTaskStore.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../../domainUsage.js';
import { runStagedLLM } from '../../../lib/stageRunner.js';
import { trimToClause } from '../../../lib/storyBible.js';
import { getSettings } from '../../settings.js';
import { buildEditorialCheckPlan } from '../editorial/checkRunner.js';
import { getSeries } from '../series.js';
import { summarizeSignals } from './state.js';
import { broadcast, providerOverrideOpts } from './session.js';
import {
  DIAGNOSIS_MAX_FILED, SELF_IMPROVE_AREAS, buildDiagnosisStageVars, buildDiagnosisTask,
  isActionableDiagnosis, shapeDiagnosis, terminalWarrantsDiagnosis,
} from './diagnosisCore.js';

const OBSERVER_STAGE = 'pipeline-observer';

// The base vocabulary plus `ui` — the observer's fix can also be "the autopilot
// panel is missing a knob the user needed", the one area the post-mortem never
// files because a human triages its briefs and can make that call themselves.
// (Safe to derive with a spread: diagnosisCore is a leaf, outside this
// package's session.js import cycle.)
export const OBSERVER_AREAS = Object.freeze([...SELF_IMPROVE_AREAS, 'ui']);

// Higher than SELF_IMPROVE_MIN_CONFIDENCE: nobody reads this brief before a
// coding agent acts on it and merges the result, so a speculative diagnosis
// must die here rather than in a human's approval queue.
export const OBSERVER_MIN_CONFIDENCE = 0.7;

// Spend ceiling for the in-flight passes; the terminal pass is a separate
// (single) beat on top, so a run makes at most MIDRUN + 1 observer calls.
export const OBSERVER_MAX_MIDRUN_PASSES = 3;

// The retained frame types that justify spending a MID-RUN pass. Narrower than
// the full signal set: `verify:round`/`foundation:round` are loops working as
// designed (a loop that never converges shows up as a pause, which the terminal
// pass reads), and `note`/`revision:*` are informational. A retained
// `check:complete` counts only when the check actually THREW — the retention
// filter also keeps `skipped` frames, which are usually benign.
const MIDRUN_TRIGGER_TYPES = new Set(['child:retry', 'child:escalate', 'step:skip', 'gap:filed']);
const isMidrunTrigger = (s) => MIDRUN_TRIGGER_TYPES.has(s.type)
  || (s.type === 'check:complete' && !!s.error);

/**
 * Is the observer active for this run? Pure. Exported for the orchestrator's
 * postMortem supersession gate, so "observer on" means the same thing at both
 * decision points.
 */
export const observerEnabled = (record) => !!record
  && record.options?.observer === true
  && record.mode === 'execute';

/** The retained frames the run has emitted since the last observer pass. Pure. */
export function freshSignals(record) {
  return (record.signals || []).slice(record.runState?.observerCursor || 0);
}

/**
 * Should the observer spend a pass after this step? Pure. Requires the opt-in,
 * a remaining mid-run pass, budget not already known-exhausted, and at least
 * one triggering frame past the cursor — a step that went cleanly costs
 * nothing. This runs after EVERY step, so the scan is by index (no slice
 * allocation on the happy path).
 */
export function shouldObserveStep(record) {
  if (!observerEnabled(record)) return false;
  const rs = record.runState || {};
  if (rs.observerBudgetExhausted) return false;
  if ((rs.observerPassesRun || 0) >= OBSERVER_MAX_MIDRUN_PASSES) return false;
  const signals = record.signals || [];
  for (let i = rs.observerCursor || 0; i < signals.length; i += 1) {
    if (isMidrunTrigger(signals[i])) return true;
  }
  return false;
}

/**
 * Should the observer spend its terminal pass? Pure — the enable predicate
 * composed with the shared terminal ladder (pause/error always, cancel never,
 * `done` only when the automation limped).
 */
export function shouldObserveTerminal(record, outcome) {
  return observerEnabled(record) && terminalWarrantsDiagnosis(record, outcome);
}

/** Should this shaped diagnosis dispatch an agent? Pure — observer bar. */
export function isDispatchable(diagnosis) {
  return isActionableDiagnosis(diagnosis, OBSERVER_MIN_CONFIDENCE);
}

/**
 * Shape the auto-approved CoS task for a dispatchable diagnosis. Pure. The
 * dedup key/one-line-description contract and the brief layout live in
 * `diagnosisCore.js#buildDiagnosisTask`; this supplies the observer's wording
 * and its one deliberate policy divergence, `approvalRequired: false` — the
 * whole point of the observer is that the fix lands without a human gate,
 * which the user opted into by enabling it. The PR still goes through the
 * review loop before merging.
 */
export function buildObserverTask({ diagnosis, seriesId, seriesName, phase, outcome, outcomeReason, counts }) {
  return buildDiagnosisTask({
    diagnosis,
    descriptionPrefix: 'Pipeline orchestrator improvement',
    leadLine: `The autopilot's observing orchestrator diagnosed a PortOS pipeline defect mid-flight: ${diagnosis.title}`,
    tailLines: [
      `Observed ${phase} during an autopilot run on series ${seriesId}${seriesName ? ` ("${seriesName}")` : ''}${outcome ? ` that ended \`${outcome}\`` : ''}${outcomeReason ? ` — ${trimToClause(outcomeReason, 500)}` : ''}.`,
      `Signal counts: ${JSON.stringify(counts)}.`,
      'This task is auto-approved and its PR will merge after the review loop — confirm the defect in the code before changing anything, keep the change minimal, and abandon it (close the task without a PR) if the defect does not reproduce in the source.',
    ],
    approvalRequired: false,
  });
}

/**
 * Run one observer pass — mid-run (`phase: 'step'`, after `stepKind`) or
 * terminal (`phase: 'terminal'`, with the run's outcome) — and dispatch an
 * auto-approved PortOS task when the verdict clears the bar.
 *
 * Best-effort by contract, like the self-improve pass: callers `.catch()` it
 * and a skip is silent — observing a run must never break the run. Returns null
 * when nothing was filed, else `{ area, title, taskId, filed, duplicate }`.
 */
export async function runObserverPass(sId, record, { phase, stepKind = null, outcome = null, reason = null } = {}) {
  const terminal = phase === 'terminal';
  const gate = terminal ? shouldObserveTerminal(record, outcome) : shouldObserveStep(record);
  if (!gate) return null;

  const rs = record.runState || {};
  const budget = await getDomainBudgetStatus('cos');
  if (!budget.withinBudget) {
    // Latch mid-run passes off for the rest of the run: without this, the
    // untaken trigger frame keeps passing the gate and every remaining step
    // re-reads the usage file just to learn "still no budget". The terminal
    // pass deliberately ignores the latch — the day (and the budget) may have
    // rolled over by then, and it re-checks exactly once.
    if (!terminal) rs.observerBudgetExhausted = true;
    return null;
  }

  // A mid-run pass reads the window since the last pass (and consumes it — the
  // same frames are never billed twice); the terminal pass reads the whole
  // retained log, the way the post-mortem does.
  const windowed = terminal ? (record.signals || []) : freshSignals(record);
  if (!terminal) {
    rs.observerCursor = (record.signals || []).length;
    rs.observerPassesRun = (rs.observerPassesRun || 0) + 1;
  }

  const [series, settings] = await Promise.all([
    getSeries(sId).catch(() => null),
    getSettings().catch(() => null),
  ]);
  const checkPlan = await buildEditorialCheckPlan(sId, { settings }).catch(() => null);
  const { counts, dropped } = summarizeSignals(record);

  broadcast(sId, { type: 'observer:start', runId: record.runId, phase, stepKind, signals: windowed.length });

  const { content } = await runStagedLLM(OBSERVER_STAGE, {
    ...buildDiagnosisStageVars(record, { series, checkPlan, signals: windowed, counts, dropped }),
    phase: terminal ? `terminal (run ended \`${outcome}\`)` : `mid-run, after the \`${stepKind}\` step`,
    outcome: outcome || 'in-progress',
    outcomeReason: trimToClause(reason, 1000) || 'none',
    // What this run already filed, so a later pass proposes the NEXT fix
    // instead of re-describing the one already dispatched.
    priorFilings: (rs.observerFindings || []).map((f) => `${f.area}: ${f.title}`).join('\n') || 'none',
  }, { ...providerOverrideOpts(record), returnsJson: true, source: OBSERVER_STAGE });
  await recordDomainUsage('cos', { actions: 1 });

  const diagnosis = shapeDiagnosis(content, OBSERVER_AREAS);
  if (!isDispatchable(diagnosis)) {
    console.log(`👁️ autopilot observer — series=${sId.slice(0, 12)} ${phase} pass filed nothing (verdict=${diagnosis?.verdict || 'unreadable'} confidence=${diagnosis?.confidence ?? '—'})`);
    return null;
  }

  const task = buildObserverTask({
    diagnosis,
    seriesId: sId,
    seriesName: series?.name || null,
    phase: terminal ? 'at the terminal' : `after the ${stepKind} step`,
    outcome,
    outcomeReason: reason,
    counts,
  });
  const result = await cosTaskStore.addTask(task, 'internal')
    .catch((err) => { console.log(`⚠️ autopilot: observer filing failed: ${err.message}`); return null; });
  const filed = !!result && !result.duplicate;
  const summary = {
    area: diagnosis.area,
    title: diagnosis.title,
    taskId: result?.id || null,
    filed,
    duplicate: !!result?.duplicate,
  };
  if (result) {
    if (!rs.observerFindings) rs.observerFindings = [];
    if (rs.observerFindings.length < DIAGNOSIS_MAX_FILED) rs.observerFindings.push(summary);
    broadcast(sId, { type: 'observer:filed', runId: record.runId, ...summary });
  }
  console.log(`👁️ autopilot observer — series=${sId.slice(0, 12)} area=${diagnosis.area} ${result ? (filed ? `dispatched ${result.id}` : 'duplicate of an open task') : 'filing failed'}`);
  return summary;
}

/**
 * Roll the run's observer activity into the terminal frame + persisted marker
 * shape. Null when the observer never filed anything (nothing to report). Pure.
 */
export function summarizeObserver(record) {
  const filed = record?.runState?.observerFindings || [];
  if (filed.length === 0) return null;
  return { passes: record.runState?.observerPassesRun || 0, filed };
}
