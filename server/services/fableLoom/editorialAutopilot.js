/**
 * Bounded FableLoom editor/reviewer autopilot.
 *
 * A user-triggered run alternates one whole-series remediation call with one
 * branching-playthrough judge call until the story clears the deterministic
 * and narrative gates, reaches its round budget, plateaus, is canceled, or a
 * provider fails. Runs are process-local like FableLoom production batches;
 * the loom writes themselves remain durable.
 */

import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { LOOM_LIMITS } from '../../lib/fableLoomLimits.js';
import { trimTo } from '../../lib/storyBible.js';
import { getLoom, mutateLoom } from './records.js';
import {
  evaluateAndRemediateFableLoom,
  reviewFableLoomPlaythroughs,
} from './editorial.js';
import {
  runFableLoomEditorialSelfImprove,
  shouldDiagnoseFableLoomEditorial,
} from './editorialSelfImprove.js';

export const FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS = Object.freeze({
  DEFAULT_ROUNDS: 3,
  MAX_ROUNDS: LOOM_LIMITS.EDITORIAL_AUTOPILOT_ROUNDS_MAX,
  MAX_RESPONSE_CORRECTIONS: 2,
  RUN_MAX_AGE_MS: 2 * 60 * 60 * 1000,
  MAX_CONCURRENT_RUNS: 10,
});

const runs = new Map();
const latestRunByLoom = new Map();

const nowIso = () => new Date().toISOString();
const errorMessage = (error) => error?.message || String(error);
const isTerminal = (run) => ['completed', 'paused', 'failed', 'canceled'].includes(run?.status);
const boundedRounds = (value) => (Number.isInteger(value)
  ? Math.max(1, Math.min(FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_ROUNDS, value))
  : FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.DEFAULT_ROUNDS);

const cleanStaleRuns = () => {
  const cutoff = Date.now() - FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.RUN_MAX_AGE_MS;
  for (const [runId, run] of runs.entries()) {
    if (!isTerminal(run)) continue;
    const updatedAt = Date.parse(run.updatedAt || run.createdAt || '');
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
      runs.delete(runId);
      if (latestRunByLoom.get(run.loomId) === runId) latestRunByLoom.delete(run.loomId);
    }
  }
};

const touch = (run, patch = {}) => {
  Object.assign(run, patch, { updatedAt: nowIso() });
  return run;
};

const compactDeterministic = (deterministic) => ({
  passed: deterministic.passed,
  complete: deterministic.complete,
  stats: deterministic.stats,
  issues: deterministic.episodes.flatMap((episode) => episode.issues.map((issue) => ({
    ...issue,
    episodeId: episode.episodeId,
  }))).slice(0, 80),
});

const residualFindings = (playtest) => [
  ...(playtest.diagnostics?.findings || []),
  ...playtest.deterministic.episodes.flatMap((episode) => episode.issues.map((issue) => ({
    severity: issue.severity === 'error' ? 'high' : 'medium',
    category: 'structure',
    episodeId: episode.episodeId,
    nodeId: issue.nodeId || null,
    pathId: issue.pathId || null,
    problem: issue.message,
    suggestion: 'Repair the graph or branch contract before the next playthrough review.',
  }))),
  ...(playtest.review?.findings || []),
].slice(0, 80);

const findingSignature = (findings) => findings.map((finding) => [
  finding.severity,
  finding.category,
  finding.episodeId,
  finding.nodeId,
  finding.pathId,
  finding.problem,
].join('|')).sort().join('\n');

const guidanceFromFindings = (findings, summary = '') => trimTo([
  summary ? `Previous playthrough review: ${summary}` : '',
  ...findings.map((finding) => [
    `[${finding.severity}/${finding.category}]`,
    `episode=${finding.episodeId || 'series'}`,
    `node=${finding.nodeId || '-'}`,
    `path=${finding.pathId || '-'}`,
    finding.problem,
    finding.suggestion ? `Fix: ${finding.suggestion}` : '',
  ].filter(Boolean).join(' ')),
].filter(Boolean).join('\n'), 4000);

const routeOptions = (run) => ({
  ...(run.route.providerId ? { providerId: run.route.providerId } : {}),
  ...(run.route.model ? { model: run.route.model } : {}),
  ...(run.route.effort ? { effort: run.route.effort } : {}),
});

const responseCorrectionGuidance = (guidance, error, attempt) => trimTo([
  'The previous editor response was rejected before any story changes were saved.',
  `Validator feedback: ${errorMessage(error)}`,
  `Correction attempt ${attempt} of ${FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_RESPONSE_CORRECTIONS}. Re-read the exact episode, scene, and transition ids in the teleplay digest. Return a corrected, graph-safe patch using only those ids; do not omit the original editorial work.`,
  guidance,
].filter(Boolean).join('\n\n'), 5000);

const invalidResponseExhaustedError = () => new ServerError(
  `Editorial autopilot could not obtain a graph-safe editor patch after ${FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_RESPONSE_CORRECTIONS + 1} attempts. Retry with a different model or repair the affected path manually, then restart autopilot.`,
  { status: 502, code: 'FABLELOOM_AUTOPILOT_INVALID_RESPONSE' },
);

const runRemediationStep = (
  run,
  round,
  baseGuidance,
  correctionAttempt = 0,
  attemptGuidance = baseGuidance,
) => (
  evaluateAndRemediateFableLoom(run.loomId, {
    ...routeOptions(run),
    guidance: attemptGuidance,
  }).catch((error) => {
    if (run.cancelRequested || error?.code !== 'AI_RESPONSE_INVALID') throw error;
    touch(run, { invalidResponses: (run.invalidResponses || 0) + 1 });
    if (correctionAttempt >= FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_RESPONSE_CORRECTIONS) {
      throw invalidResponseExhaustedError();
    }
    const nextCorrectionAttempt = correctionAttempt + 1;
    const nextEditorAttempt = nextCorrectionAttempt + 1;
    touch(run, {
      currentStep: 'response-correction',
      stepLabel: 'Correct editor response',
      correctionAttempt: nextCorrectionAttempt,
      responseCorrections: (run.responseCorrections || 0) + 1,
      message: `Step ${run.stepIndex} of up to ${run.stepCount} · round ${round}: correcting a rejected editor patch (attempt ${nextEditorAttempt} of ${FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_RESPONSE_CORRECTIONS + 1})…`,
    });
    return runRemediationStep(
      run,
      round,
      baseGuidance,
      nextCorrectionAttempt,
      responseCorrectionGuidance(baseGuidance, error, nextCorrectionAttempt),
    );
  })
);

const finishCanceled = (run, terminalFacts = {}) => touch(run, {
  status: 'canceled',
  currentStep: null,
  stepLabel: null,
  message: 'Editorial autopilot canceled after the active AI step finished.',
  completedAt: nowIso(),
  ...terminalFacts,
});

const terminalDiagnosis = async (run, outcome, { reason = null, error = null } = {}) => {
  if (!shouldDiagnoseFableLoomEditorial(run, outcome)) return null;
  const sourceStep = run.currentStep;
  touch(run, {
    currentStep: 'self-improve',
    message: 'Diagnosing whether the editorial automation itself should improve…',
  });
  return runFableLoomEditorialSelfImprove(run, {
    outcome,
    reason,
    sourceStep,
    errorCode: error?.code || null,
  }).catch((diagnosisError) => {
    console.log(`⚠️ FableLoom self-improve diagnosis failed: ${diagnosisError.message}`);
    return null;
  });
};

const finishPaused = async (run, pauseReason, message) => {
  const selfImprove = await terminalDiagnosis(run, 'paused', { reason: pauseReason });
  if (run.cancelRequested) return finishCanceled(run, { pauseReason, message, selfImprove });
  return touch(run, {
    status: 'paused',
    pauseReason,
    currentStep: null,
    stepLabel: null,
    message,
    selfImprove,
    completedAt: nowIso(),
  });
};

const finishFailed = async (run, error) => {
  const selfImprove = await terminalDiagnosis(run, 'failed', { reason: 'run-error', error });
  if (run.cancelRequested) return finishCanceled(run, {
    error: errorMessage(error),
    message: errorMessage(error),
    selfImprove,
  });
  return touch(run, {
    status: 'failed',
    currentStep: null,
    stepLabel: null,
    message: errorMessage(error),
    error: errorMessage(error),
    selfImprove,
    completedAt: nowIso(),
  });
};

async function runRound(run, guidance) {
  const round = run.round + 1;
  const remediationStep = ((round - 1) * 2) + 1;
  touch(run, {
    round,
    currentStep: 'evaluate-remediate',
    stepIndex: remediationStep,
    stepLabel: 'Evaluate and remediate',
    correctionAttempt: 0,
    message: `Step ${remediationStep} of up to ${run.stepCount} · round ${round}: evaluating and remediating the complete series…`,
  });
  const remediation = await runRemediationStep(run, round, guidance);
  if (run.cancelRequested) return finishCanceled(run);

  const reviewStep = remediationStep + 1;
  touch(run, {
    currentStep: 'playthrough-review',
    stepIndex: reviewStep,
    stepLabel: 'Review every playthrough',
    correctionAttempt: 0,
    message: `Step ${reviewStep} of up to ${run.stepCount} · round ${round}: exercising and reviewing branching playthroughs…`,
  });
  const playtest = await reviewFableLoomPlaythroughs(run.loomId, {
    ...routeOptions(run),
    aiReview: true,
    ...(run.maxPaths ? { maxPaths: run.maxPaths } : {}),
  });
  if (run.cancelRequested) return finishCanceled(run);

  const residual = residualFindings(playtest);
  const snapshot = {
    round,
    changed: remediation.changed,
    changes: remediation.changes,
    before: remediation.before,
    after: remediation.after,
    evaluation: remediation.evaluation,
    diagnostics: playtest.diagnostics,
    deterministic: compactDeterministic(playtest.deterministic),
    review: playtest.review,
    passed: playtest.passed,
  };
  run.rounds.push(snapshot);
  run.residualFindings = residual;
  run.lastEvaluation = remediation.evaluation;
  run.lastPlaytest = snapshot.deterministic;
  run.lastReview = playtest.review;

  if (playtest.passed) {
    const approvedAt = nowIso();
    await mutateLoom(run.loomId, (loom) => ({
      ...loom,
      productionStatus: {
        ...loom.productionStatus,
        editorialApprovedAt: approvedAt,
        editorialApprovalSource: 'autopilot',
        deliveryApprovedAt: null,
      },
    }));
    return touch(run, {
      status: 'completed',
      currentStep: null,
      stepLabel: null,
      message: `Editorial autopilot completed after ${round} round${round === 1 ? '' : 's'}.`,
      completedAt: approvedAt,
    });
  }

  const signature = findingSignature(residual);
  const plateau = !remediation.changed && signature === run.previousFindingSignature;
  run.previousFindingSignature = signature;
  if (plateau) {
    return finishPaused(
      run,
      'plateau',
      'Editorial autopilot paused because another safe pass produced no changes and the same findings remained.',
    );
  }
  if (round >= run.maxRounds) {
    return finishPaused(
      run,
      'round-limit',
      `Editorial autopilot reached its ${run.maxRounds}-round limit with review findings still open.`,
    );
  }

  touch(run, {
    message: `Round ${round} left ${residual.length} finding${residual.length === 1 ? '' : 's'}; preparing another repair pass.`,
  });
  return runRound(run, guidanceFromFindings(residual, playtest.review?.summary));
}

/** Start and detach a bounded editor/reviewer run. */
export async function startFableLoomEditorialAutopilot(loomId, {
  maxRounds, maxPaths, providerId, model, effort, selfImprove,
} = {}) {
  cleanStaleRuns();
  await requireLoomForRun(loomId);
  const currentId = latestRunByLoom.get(loomId);
  const current = currentId ? runs.get(currentId) : null;
  if (current && ['running', 'canceling'].includes(current.status)) {
    return { ...current, alreadyRunning: true };
  }
  const activeCount = [...runs.values()].filter((run) => ['running', 'canceling'].includes(run.status)).length;
  if (activeCount >= FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_CONCURRENT_RUNS) {
    throw new ServerError('The maximum number of FableLoom editorial autopilots is already running.', {
      status: 409,
      code: 'FABLELOOM_AUTOPILOT_LIMIT',
    });
  }

  const createdAt = nowIso();
  const run = {
    id: `editorial-${randomUUID()}`,
    loomId,
    status: 'running',
    currentStep: 'starting',
    round: 0,
    maxRounds: boundedRounds(maxRounds),
    stepIndex: 0,
    stepCount: boundedRounds(maxRounds) * 2,
    stepLabel: 'Starting',
    correctionAttempt: 0,
    responseCorrections: 0,
    invalidResponses: 0,
    maxResponseCorrections: FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS.MAX_RESPONSE_CORRECTIONS,
    maxPaths: Number.isInteger(maxPaths) ? maxPaths : null,
    route: {
      providerId: providerId || null,
      model: model || null,
      effort: effort || null,
    },
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    cancelRequested: false,
    pauseReason: null,
    selfImproveEnabled: selfImprove === true,
    selfImprove: null,
    message: 'Starting FableLoom editorial autopilot…',
    error: null,
    rounds: [],
    residualFindings: [],
    lastEvaluation: null,
    lastPlaytest: null,
    lastReview: null,
    previousFindingSignature: null,
  };
  runs.set(run.id, run);
  latestRunByLoom.set(loomId, run.id);
  void runRound(run, '')
    .catch((error) => (run.cancelRequested ? finishCanceled(run) : finishFailed(run, error)))
    .catch((error) => {
      console.error(`❌ FableLoom editorial autopilot terminal handling failed: ${error.message}`);
      touch(run, {
        status: 'failed',
        currentStep: null,
        stepLabel: null,
        message: errorMessage(error),
        error: errorMessage(error),
        completedAt: nowIso(),
      });
    });
  return run;
}

const requireLoomForRun = async (loomId) => {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  return loom;
};

export function getFableLoomEditorialAutopilot(runId) {
  cleanStaleRuns();
  return runs.get(runId) || null;
}

export function getLatestFableLoomEditorialAutopilot(loomId) {
  cleanStaleRuns();
  const runId = latestRunByLoom.get(loomId);
  return runId ? runs.get(runId) || null : null;
}

/** Cooperative cancellation: the active provider call finishes, then the run stops. */
export function cancelFableLoomEditorialAutopilot(runId) {
  const run = runs.get(runId);
  if (!run) throw new ServerError('Editorial autopilot run not found', { status: 404, code: 'NOT_FOUND' });
  if (run.status !== 'running') return run;
  run.cancelRequested = true;
  return touch(run, {
    status: 'canceling',
    message: 'Cancel requested; the active AI step will finish before the run stops.',
  });
}

export function publicFableLoomEditorialAutopilot(run) {
  if (!run) return null;
  const { previousFindingSignature: _signature, ...publicRun } = run;
  return publicRun;
}

export function _resetFableLoomEditorialAutopilots() {
  runs.clear();
  latestRunByLoom.clear();
}

export const __testing = {
  boundedRounds,
  compactDeterministic,
  findingSignature,
  guidanceFromFindings,
  responseCorrectionGuidance,
  residualFindings,
  runs,
};
