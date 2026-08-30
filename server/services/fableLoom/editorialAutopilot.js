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
import { getLoom } from './records.js';
import {
  evaluateAndRemediateFableLoom,
  reviewFableLoomPlaythroughs,
} from './editorial.js';

export const FABLELOOM_EDITORIAL_AUTOPILOT_LIMITS = Object.freeze({
  DEFAULT_ROUNDS: 3,
  MAX_ROUNDS: LOOM_LIMITS.EDITORIAL_AUTOPILOT_ROUNDS_MAX,
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

const finishCanceled = (run) => touch(run, {
  status: 'canceled',
  currentStep: null,
  message: 'Editorial autopilot canceled after the active AI step finished.',
  completedAt: nowIso(),
});

const finishFailed = (run, error) => touch(run, {
  status: 'failed',
  currentStep: null,
  message: errorMessage(error),
  error: errorMessage(error),
  completedAt: nowIso(),
});

async function runRound(run, guidance) {
  const round = run.round + 1;
  touch(run, {
    round,
    currentStep: 'evaluate-remediate',
    message: `Round ${round}: evaluating and remediating the complete series…`,
  });
  const remediation = await evaluateAndRemediateFableLoom(run.loomId, {
    ...routeOptions(run),
    guidance,
  });
  if (run.cancelRequested) return finishCanceled(run);

  touch(run, {
    currentStep: 'playthrough-review',
    message: `Round ${round}: exercising and reviewing branching playthroughs…`,
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
    return touch(run, {
      status: 'completed',
      currentStep: null,
      message: `Editorial autopilot completed after ${round} round${round === 1 ? '' : 's'}.`,
      completedAt: nowIso(),
    });
  }

  const signature = findingSignature(residual);
  const plateau = !remediation.changed && signature === run.previousFindingSignature;
  run.previousFindingSignature = signature;
  if (plateau) {
    return touch(run, {
      status: 'paused',
      pauseReason: 'plateau',
      currentStep: null,
      message: 'Editorial autopilot paused because another safe pass produced no changes and the same findings remained.',
      completedAt: nowIso(),
    });
  }
  if (round >= run.maxRounds) {
    return touch(run, {
      status: 'paused',
      pauseReason: 'round-limit',
      currentStep: null,
      message: `Editorial autopilot reached its ${run.maxRounds}-round limit with review findings still open.`,
      completedAt: nowIso(),
    });
  }

  touch(run, {
    message: `Round ${round} left ${residual.length} finding${residual.length === 1 ? '' : 's'}; preparing another repair pass.`,
  });
  return runRound(run, guidanceFromFindings(residual, playtest.review?.summary));
}

/** Start and detach a bounded editor/reviewer run. */
export async function startFableLoomEditorialAutopilot(loomId, {
  maxRounds, maxPaths, providerId, model, effort,
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
  void runRound(run, '').catch((error) => (
    run.cancelRequested ? finishCanceled(run) : finishFailed(run, error)
  ));
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
  residualFindings,
  runs,
};
