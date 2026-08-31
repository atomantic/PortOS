/**
 * FableLoom editorial-autopilot self-improvement (opt-in post-mortem).
 *
 * The editor/reviewer loop judges the STORY. This pass judges the AUTOMATION:
 * after a paused or failed run, it reads a compact, content-free account of
 * what each round did and asks whether PortOS itself is inefficient, broken,
 * or missing a useful control. A confident PortOS verdict files one deduped,
 * approval-gated CoS task; story problems file nothing.
 *
 * The task can lead to a public PR, so neither the prompt variables nor the
 * task brief contain loom names, record ids, scene text, findings, or provider
 * output. Only bounded counters, status vocabulary, and error codes cross this
 * boundary.
 */

import * as cosTaskStore from '../cosTaskStore.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { runStagedLLM } from '../stageRunner.js';
import {
  buildDiagnosisTask,
  isActionableDiagnosis,
  shapeDiagnosis,
} from '../pipeline/seriesAutopilot/diagnosisCore.js';

const SELF_IMPROVE_STAGE = 'fableloom-editorial-self-improve';

export const FABLELOOM_EDITORIAL_SELF_IMPROVE_AREAS = Object.freeze([
  'editorial-check', 'pipeline-step', 'prompt', 'runner', 'config', 'ui',
]);

export const FABLELOOM_EDITORIAL_SELF_IMPROVE_MIN_CONFIDENCE = 0.6;

const countBy = (items, key) => {
  const list = Array.isArray(items) ? items : [];
  return Object.fromEntries(
    [...new Set(list.map((item) => item?.[key]).filter(Boolean))]
      .sort()
      .map((value) => [value, list.filter((item) => item?.[key] === value).length]),
  );
};

const numericStats = (stats) => Object.fromEntries(
  Object.entries(stats || {}).filter(([, value]) => Number.isFinite(value)),
);

const safeToken = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const token = value.trim();
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(token) ? token : fallback;
};

const compactRound = (round) => ({
  round: round.round,
  remediation: {
    changed: round.changed === true,
    changeCount: Array.isArray(round.changes) ? round.changes.length : 0,
    before: numericStats(round.before),
    after: numericStats(round.after),
    evaluationFindingCount: round.evaluation?.findings?.length || 0,
  },
  playthrough: {
    passed: round.passed === true,
    diagnosticsPassed: round.diagnostics?.passed === true,
    diagnosticFindingCount: round.diagnostics?.findings?.length || 0,
    deterministicPassed: round.deterministic?.passed === true,
    deterministicComplete: round.deterministic?.complete === true,
    stats: numericStats(round.deterministic?.stats),
    reviewPassed: round.review?.passed === true,
    qualityScore: Number.isFinite(round.review?.qualityScore) ? round.review.qualityScore : null,
    reviewFindingCount: round.review?.findings?.length || 0,
    findingCategories: countBy(round.review?.findings, 'category'),
    findingSeverities: countBy(round.review?.findings, 'severity'),
  },
});

/** A clean completion and a user cancellation do not warrant a diagnosis call. */
export const shouldDiagnoseFableLoomEditorial = (run, outcome) => (
  run?.selfImproveEnabled === true && ['paused', 'failed'].includes(outcome)
);

/**
 * Content-free evidence sent to the diagnosis stage. Exported so the privacy
 * boundary and the useful counters can be pinned in focused tests.
 */
export function buildFableLoomEditorialTelemetry(run, {
  outcome,
  reason = null,
  sourceStep = null,
  errorCode = null,
} = {}) {
  return {
    outcome: safeToken(outcome, 'unknown'),
    reason: safeToken(reason, 'none'),
    sourceStep: safeToken(sourceStep, 'unknown'),
    errorCode: safeToken(errorCode, 'none'),
    round: Number.isInteger(run?.round) ? run.round : 0,
    maxRounds: Number.isInteger(run?.maxRounds) ? run.maxRounds : 0,
    maxPaths: Number.isInteger(run?.maxPaths) ? run.maxPaths : 'default',
    rounds: (Array.isArray(run?.rounds) ? run.rounds : []).map(compactRound),
  };
}

export function buildFableLoomEditorialSelfImproveTask({ diagnosis, telemetry }) {
  return buildDiagnosisTask({
    diagnosis,
    descriptionPrefix: 'FableLoom editorial self-improvement',
    leadLine: `FableLoom Editorial Autopilot diagnosed a PortOS automation defect: ${diagnosis.title}`,
    tailLines: [
      `Diagnosed from a content-free autopilot summary after a \`${telemetry.outcome}\` run at round ${telemetry.round}/${telemetry.maxRounds} (step: \`${telemetry.sourceStep}\`, reason: \`${telemetry.reason}\`, error code: \`${telemetry.errorCode}\`).`,
      'Confirm the defect in the source before changing anything: this brief is one LLM\'s read of bounded run counters, not a reproduction.',
    ],
    approvalRequired: true,
  });
}

/** Run one best-effort terminal diagnosis and file a task for PortOS defects. */
export async function runFableLoomEditorialSelfImprove(run, context = {}) {
  if (!shouldDiagnoseFableLoomEditorial(run, context.outcome)) return null;

  const budget = await getDomainBudgetStatus('cos');
  if (!budget.withinBudget) return null;

  const telemetry = buildFableLoomEditorialTelemetry(run, context);
  const { content } = await runStagedLLM(SELF_IMPROVE_STAGE, {
    outcome: telemetry.outcome,
    outcomeReason: telemetry.reason,
    currentStep: telemetry.sourceStep,
    errorCode: telemetry.errorCode,
    round: telemetry.round,
    maxRounds: telemetry.maxRounds,
    maxPaths: telemetry.maxPaths,
    telemetryJson: JSON.stringify(telemetry.rounds, null, 2),
  }, {
    // Keep the selected provider when available, but let this software-focused
    // stage resolve its own heavy model instead of inheriting a story-writing
    // model (modelDefault outranks stage tiers in stageRunner).
    ...(run?.route?.providerId ? { providerDefault: run.route.providerId } : {}),
    returnsJson: true,
    source: SELF_IMPROVE_STAGE,
  });
  await recordDomainUsage('cos', { actions: 1 });

  // Cancellation remains cooperative even if it arrived while this final LLM
  // call was running: do not file new work after the user asked the run to stop.
  if (run.cancelRequested) return null;

  const diagnosis = shapeDiagnosis(content, FABLELOOM_EDITORIAL_SELF_IMPROVE_AREAS);
  if (!isActionableDiagnosis(diagnosis, FABLELOOM_EDITORIAL_SELF_IMPROVE_MIN_CONFIDENCE)) {
    console.log(`🔧 FableLoom self-improve: nothing filed (verdict=${diagnosis?.verdict || 'unreadable'} confidence=${diagnosis?.confidence ?? '—'})`);
    return null;
  }

  const task = buildFableLoomEditorialSelfImproveTask({ diagnosis, telemetry });
  const result = await cosTaskStore.addTask(task, 'internal')
    .catch((error) => {
      console.log(`⚠️ FableLoom self-improve task filing failed: ${error.message}`);
      return null;
    });
  const filed = !!result && !result.duplicate;
  console.log(`🔧 FableLoom self-improve: area=${diagnosis.area} ${result ? (filed ? `filed ${result.id}` : 'duplicate of an open task') : 'filing failed'}`);
  return {
    verdict: diagnosis.verdict,
    area: diagnosis.area,
    title: diagnosis.title,
    taskId: result?.id || null,
    filed,
    duplicate: !!result?.duplicate,
  };
}
