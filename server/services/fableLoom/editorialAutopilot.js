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

// Planning is an explicit, bounded phase: finish the series contract before
// drafting any episode, and never expand a teleplay or approve production here.
async function runPlanning(run) {
  const { reviewSeriesPlan, feedbackSeriesPlan, generateEpisodeOutline, reviewEpisodeOutline, validateEpisodeOutline } = await import('./weave.js');
  const { analyzeSeriesStoryOutlines } = await import('../../lib/fableLoomOutline.js');
  const options = routeOptions(run);
  const initial = await requireLoomForRun(run.loomId);
  if (run.cancelRequested) return finishCanceled(run);
  if (!initial.seriesPlan?.storyArc?.trim() || (initial.seriesPlan?.plotPoints || []).some((item) => !initial.episodes.some((episode) => episode.id === item.episodeId))) {
    return finishPaused(run, 'planning-required', 'Save the story arc and assign every plot point and challenge to an episode before starting planning autopilot.');
  }
  touch(run, { round: 1, currentStep: 'review-plan', stepIndex: 1, stepLabel: 'Review series plan', message: 'Checking the series arc and challenge assignments before drafting episode outlines…' });
  const review = await reviewSeriesPlan(run.loomId, { ...options, planningOnly: true });
  if (run.cancelRequested) return finishCanceled(run);
  const planFindings = review.analysis.risks;
  if (planFindings.length) {
    touch(run, { currentStep: 'repair-plan', stepLabel: 'Refine series plan', message: 'Resolving planning findings before episode outlines…' });
    await feedbackSeriesPlan(run.loomId, { ...options, feedback: trimTo(`Resolve these planning findings before scene production. Preserve the episode count and ids. Map every challenge to its intended episode with setup, decision, success, failure and recovery. Do not expand scenes.\n${planFindings.join('\n')}`, 4000) });
    if (run.cancelRequested) return finishCanceled(run);
  }
  let loom = await requireLoomForRun(run.loomId);
  const unmapped = (loom.seriesPlan?.plotPoints || []).filter((item) => item.kind === 'challenge' && !loom.episodes.some((episode) => episode.id === item.episodeId));
  if (!loom.seriesPlan?.storyArc?.trim() || unmapped.length) {
    return finishPaused(run, 'planning-required', 'Save a story arc and assign every challenge to an episode before drafting outlines.');
  }
  for (const [index, episode] of loom.episodes.entries()) {
    let guidance = 'Follow the complete series plan. Each outline scene is a camera-cut beat, not a whole dramatic scene. Preserve each assigned challenge id and represent setup, decision, success, failure and recovery as separate beats. Keep branches purposeful and fail forward. Draft only the outline, never full scene prose.';
    for (let attempt = 1; attempt <= run.maxRounds; attempt += 1) {
      touch(run, { round: attempt, currentStep: 'outline-episode', stepIndex: index + 2, stepLabel: `Plan episode ${episode.number}`, message: `Planning episode ${episode.number} of ${loom.episodes.length} · attempt ${attempt}/${run.maxRounds}…` });
      const current = await requireLoomForRun(run.loomId);
      const existing = current.episodes.find((candidate) => candidate.id === episode.id);
      const generated = attempt === 1 && existing?.storyOutline?.scenes?.length
        ? await validateEpisodeOutline(run.loomId, episode.id)
        : await generateEpisodeOutline(run.loomId, episode.id, { ...options, guidance });
      if (run.cancelRequested) return finishCanceled(run);
      const errors = generated.validation?.issues?.filter((issue) => issue.severity === 'error') || [];
      const checked = errors.length ? null : await reviewEpisodeOutline(run.loomId, episode.id, { ...options, planningGate: true });
      if (run.cancelRequested) return finishCanceled(run);
      const findings = [...errors.map((issue) => issue.message), ...(checked?.analysis?.risks || [])];
      run.residualFindings = findings.map((problem) => ({ severity: 'high', category: 'structure', episodeId: episode.id, problem }));
      if (!findings.length) {
        await validateEpisodeOutline(run.loomId, episode.id);
        break;
      }
      if (attempt === run.maxRounds) return finishPaused(run, 'round-limit', `Episode ${episode.number} still has planning findings. No teleplay or media was generated.`);
      guidance = trimTo(`Revise the outline to resolve these findings while preserving the series plan and challenge contracts:\n${findings.join('\n')}`, 4000);
    }
  }
  loom = await requireLoomForRun(run.loomId);
  const validation = analyzeSeriesStoryOutlines(loom);
  run.residualFindings = validation.issues.filter((issue) => issue.severity === 'error').map((issue) => ({ ...issue, problem: issue.message }));
  if (!validation.stats.ready) return finishPaused(run, 'planning-required', 'The complete beat arc still needs corrections before expansion. No teleplay or media was generated.');
  return touch(run, { status: 'completed', currentStep: null, stepLabel: null, stepIndex: run.stepCount, message: 'Series planning complete. All episode outlines are ready; choose the episode to expand next.', completedAt: nowIso() });
}

/** Start and detach a bounded editor/reviewer run. */
export async function startFableLoomEditorialAutopilot(loomId, {
  maxRounds, maxPaths, providerId, model, effort, selfImprove, mode = 'series',
} = {}) {
  cleanStaleRuns();
  const loom = await requireLoomForRun(loomId);
  if (mode === 'planning' && (!loom.episodes?.length || loom.episodes.some((episode) => episode.nodes?.length))) {
    throw new ServerError('Planning autopilot requires episode slots with no expanded scenes. Add the planned episodes first.', { status: 409, code: 'PLANNING_SCOPE_REQUIRED' });
  }
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
    mode,
    status: 'running',
    currentStep: 'starting',
    round: 0,
    maxRounds: boundedRounds(maxRounds),
    stepIndex: 0,
    stepCount: mode === 'planning' ? loom.episodes.length + 2 : boundedRounds(maxRounds) * 2,
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
  void (mode === 'planning' ? runPlanning(run) : runRound(run, ''))
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
