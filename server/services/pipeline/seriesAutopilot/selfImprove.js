/**
 * Series Autopilot — pipeline self-improvement (opt-in meta-diagnosis).
 *
 * Every other gate in this conductor judges the STORY. This one judges the
 * AUTOMATION: when a run ends badly — or finishes carrying unhealthy telemetry —
 * it asks whether the failure is a content problem (the manuscript needs human
 * editorial work) or a PIPELINE problem (PortOS is missing an editorial step
 * earlier in the process, a stage prompt keeps producing unusable output, a
 * runner swallows a failure, a gate is misconfigured). On a pipeline verdict it
 * files a CoS task against PortOS itself so the automation gets fixed instead of
 * the same defect being re-diagnosed by hand on every series.
 *
 * Three properties keep this from becoming a spend/spam hazard:
 *
 *  1. **Opt-in, and signal-gated.** Off by default (`options.selfImprove`), and
 *     even when on, a run with clean telemetry never makes an LLM call —
 *     `shouldDiagnose` requires an actual bad signal (a pause, an error, a check
 *     that threw, a retried child, a filed craft gap, a skipped step).
 *  2. **One call per run, budget-gated.** The diagnosis is a single staged LLM
 *     call at the run's terminal, billed as one cos action and skipped when the
 *     daily budget is spent.
 *  3. **Deduped, approval-gated and worktree-isolated.** The filed task's first
 *     line is stable per (area, defect), so cosTaskStore's dedup collapses the
 *     same diagnosis across runs and series onto one open task. The task always
 *     awaits human approval, runs in a worktree, and opens a PR — an LLM's
 *     unverified read of one run's telemetry never dispatches a coding agent at
 *     PortOS's own source unattended. That matches every other autonomously
 *     generated code-editing task in PortOS (layeredIntelligence's
 *     `buildHandoffTask`, `autoFixer`, `agentErrorAnalysis` all hard-code
 *     `approvalRequired: true`); the autonomy dial for this class of work is the
 *     CoS approval queue, not a per-series checkbox. (The observing orchestrator
 *     — `observer.js` — is the ONE deliberate exception: the user opts into its
 *     unattended dispatch explicitly, and it supersedes this pass at the
 *     terminal when both are enabled.)
 *
 * The signal log is captured passively: `state.js#noteSignal`, called from
 * `session.js#broadcast`, retains the same SSE frames the run already emits — so
 * a telemetry frame a future step adds becomes diagnosable evidence with no
 * extra instrumentation. It lives in `state.js` (the run-registry owner) rather
 * than here so this module can import the registry instead of the registry
 * importing the diagnosis. The vocabulary, shape, and task/prompt frames shared
 * with the observer live in `diagnosisCore.js` (a deliberate leaf — see its
 * header) and are re-exported here for the existing import surface.
 *
 * PRIVACY: the diagnosis prompt asks for a defect report about PortOS's code and
 * prompts, explicitly NOT about the story — and `shapeDiagnosis` bounds every
 * field — because the filed task is read by a coding agent that opens a public
 * PR. Manuscript text must not travel into that task.
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
  SELF_IMPROVE_AREAS, buildDiagnosisStageVars, buildDiagnosisTask, diagnosisEnabled,
  hasAutomationSignals, isActionableDiagnosis, shapeDiagnosis, terminalWarrantsDiagnosis,
} from './diagnosisCore.js';

// Re-export the shared diagnosis vocabulary under this module's established
// import surface (tests and the barrel reach it here).
export { SELF_IMPROVE_AREAS, hasAutomationSignals, shapeDiagnosis };

const SELF_IMPROVE_STAGE = 'pipeline-self-improve';

/**
 * Does this run carry evidence worth spending a diagnosis call on? Pure — the
 * opt-in/execute predicate composed with the shared terminal ladder.
 */
export function shouldDiagnose(record, outcome) {
  return diagnosisEnabled(record, 'selfImprove') && terminalWarrantsDiagnosis(record, outcome);
}

// A diagnosis below this confidence is dropped rather than filed — a speculative
// "maybe the pipeline?" is not worth a coding agent's time.
export const SELF_IMPROVE_MIN_CONFIDENCE = 0.6;

/**
 * Should this shaped diagnosis produce a CoS task? Pure — a pipeline verdict
 * that clears the confidence bar and actually says what to change.
 */
export function isFilable(diagnosis) {
  return isActionableDiagnosis(diagnosis, SELF_IMPROVE_MIN_CONFIDENCE);
}

/**
 * Shape the approval-gated CoS task for a filable diagnosis. Pure. The dedup
 * key/one-line-description contract and the brief layout live in
 * `diagnosisCore.js#buildDiagnosisTask`; this supplies the post-mortem's
 * wording and its `approvalRequired: true` policy (see the module header).
 */
export function buildSelfImproveTask({ diagnosis, seriesId, seriesName, outcome, outcomeReason, counts }) {
  return buildDiagnosisTask({
    diagnosis,
    descriptionPrefix: 'Pipeline self-improvement',
    leadLine: `Series Autopilot diagnosed a PortOS automation defect: ${diagnosis.title}`,
    tailLines: [
      `Diagnosed from an autopilot run on series ${seriesId}${seriesName ? ` ("${seriesName}")` : ''} that ended \`${outcome}\`${outcomeReason ? ` — ${trimToClause(outcomeReason, 500)}` : ''}.`,
      `Signal counts: ${JSON.stringify(counts)}.`,
      'Confirm the defect in the code before changing anything: this brief is one LLM\'s read of a single run\'s telemetry, not a reproduction.',
    ],
    approvalRequired: true,
  });
}

/**
 * Run the meta-diagnosis at a run's terminal and file a PortOS task when the
 * verdict says the automation is at fault.
 *
 * Runs BEFORE the terminal frame is broadcast, and its summary rides that frame
 * (and the persisted marker) rather than arriving after it: a client tears its
 * stream down on the terminal frame and SSE replays only the LAST payload, so a
 * post-terminal frame would be both unseen live and destructive to the replayed
 * terminal. The `selfimprove:start` frame is the live signal that the run is
 * spending one more beat on its post-mortem.
 *
 * Best-effort by contract: callers `.catch()` it, and a skip is silent — the
 * point is that a successful run must never be turned into a failure by its own
 * post-mortem. Returns null when nothing was diagnosed, else a compact summary.
 */
export async function runSelfImproveDiagnosis(sId, record, { outcome, reason = null } = {}) {
  if (!shouldDiagnose(record, outcome)) return null;

  const budget = await getDomainBudgetStatus('cos');
  if (!budget.withinBudget) return null;

  const [series, settings] = await Promise.all([
    getSeries(sId).catch(() => null),
    getSettings().catch(() => null),
  ]);
  const checkPlan = await buildEditorialCheckPlan(sId, { settings }).catch(() => null);
  const { signals, counts, dropped } = summarizeSignals(record);

  broadcast(sId, { type: 'selfimprove:start', runId: record.runId, outcome, signals: signals.length });

  const { content } = await runStagedLLM(SELF_IMPROVE_STAGE, {
    ...buildDiagnosisStageVars(record, { series, checkPlan, signals, counts, dropped }),
    outcome,
    outcomeReason: trimToClause(reason, 1000) || 'none',
  }, { ...providerOverrideOpts(record), returnsJson: true, source: SELF_IMPROVE_STAGE });
  await recordDomainUsage('cos', { actions: 1 });

  const diagnosis = shapeDiagnosis(content);
  // Nothing filable → nothing to report. A `content` / `none` verdict means the
  // pipeline behaved, and a low-confidence guess is not worth a line of UI, so
  // the terminal frame and the marker stay clean rather than carrying a
  // "diagnosed nothing" payload no reader consumes. The log line is where an
  // operator can still see the pass ran.
  if (!isFilable(diagnosis)) {
    console.log(`🔧 autopilot self-improve — series=${sId.slice(0, 12)} nothing filed (verdict=${diagnosis?.verdict || 'unreadable'} confidence=${diagnosis?.confidence ?? '—'})`);
    return null;
  }

  const task = buildSelfImproveTask({
    diagnosis,
    seriesId: sId,
    seriesName: series?.name || null,
    outcome,
    outcomeReason: reason,
    counts,
  });
  const result = await cosTaskStore.addTask(task, 'internal')
    .catch((err) => { console.log(`⚠️ autopilot: self-improve filing failed: ${err.message}`); return null; });
  const filed = !!result && !result.duplicate;
  console.log(`🔧 autopilot self-improve — series=${sId.slice(0, 12)} area=${diagnosis.area} ${result ? (filed ? `filed ${result.id}` : 'duplicate of an open task') : 'filing failed'}`);
  return {
    verdict: diagnosis.verdict,
    area: diagnosis.area,
    title: diagnosis.title,
    // The durable pointer from "this run" to "that task" — the console line above
    // is not something a user can go read later.
    taskId: result?.id || null,
    filed,
    duplicate: !!result?.duplicate,
  };
}
