/**
 * Series Autopilot model-performance learning.
 *
 * AI run records already own technical execution telemetry. This module adds
 * the missing editorial outcome (accepted / rejected / valid assessment), then
 * aggregates those same records by pipeline step, role, provider, model and
 * effort. No parallel datastore: deleting a run also deletes its evidence.
 */

import { getAllProviders } from '../../providers.js';
import { getRun, listRuns, patchRunMetadata } from '../../runner.js';

const MAX_RUNS = 5_000;
export const MIN_QUALITY_SAMPLES = 2;
export const MIN_QUALITY_RATE = 0.6;
const POSITIVE_OUTCOMES = new Set(['accepted']);
const NEGATIVE_OUTCOMES = new Set(['rejected']);

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const modelId = (model) => {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') return model.id || model.name || null;
  return null;
};

const providerSupportsModel = (provider, model) => {
  if (!model) return true;
  const models = Array.isArray(provider?.models) ? provider.models.map(modelId).filter(Boolean) : [];
  return models.length === 0 || models.includes(model);
};

const identityKey = ({ pipelineStage, pipelineRole, providerId, model, effort }) =>
  [pipelineStage, pipelineRole, providerId, model || '', effort || ''].join('\u0000');

export function summarizeModelPerformance(runs = [], providers = []) {
  const enabled = new Map(
    (Array.isArray(providers) ? providers : [])
      .filter((provider) => provider?.enabled !== false)
      .map((provider) => [provider.id, provider]),
  );
  const groups = new Map();

  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.autopilotSystem !== 'series' || !run.pipelineStage || !run.pipelineRole || !run.providerId) continue;
    if (typeof run.success !== 'boolean') continue;
    const identity = {
      pipelineStage: run.pipelineStage,
      pipelineRole: run.pipelineRole,
      providerId: run.providerId,
      providerName: run.providerName || run.providerId,
      model: run.model || null,
      effort: run.effort || null,
    };
    const key = identityKey(identity);
    const metric = groups.get(key) || {
      ...identity,
      attempts: 0,
      technicalSuccesses: 0,
      technicalFailures: 0,
      qualityAccepted: 0,
      qualityRejected: 0,
      qualityEvaluated: 0,
      contractValid: 0,
      contractInvalid: 0,
      scoreDeltaTotal: 0,
      scoreDeltaSamples: 0,
      durationTotalMs: 0,
      durationSamples: 0,
      lastRunAt: null,
    };
    metric.attempts += 1;
    if (run.success === true) metric.technicalSuccesses += 1;
    else if (run.success === false) metric.technicalFailures += 1;
    if (run.success === true && POSITIVE_OUTCOMES.has(run.qualityOutcome)) {
      metric.qualityAccepted += 1;
      metric.qualityEvaluated += 1;
    } else if (run.success === true && NEGATIVE_OUTCOMES.has(run.qualityOutcome)) {
      metric.qualityRejected += 1;
      metric.qualityEvaluated += 1;
    }
    if (run.success === true && run.qualityOutcome === 'valid') metric.contractValid += 1;
    else if (run.success === true && run.qualityOutcome === 'invalid') metric.contractInvalid += 1;
    const delta = finiteOrNull(run.qualityScoreDelta);
    if (delta !== null) {
      metric.scoreDeltaTotal += delta;
      metric.scoreDeltaSamples += 1;
    }
    const duration = finiteOrNull(run.duration);
    if (duration !== null && duration >= 0) {
      metric.durationTotalMs += duration;
      metric.durationSamples += 1;
    }
    if (!metric.lastRunAt || String(run.startTime || '') > metric.lastRunAt) metric.lastRunAt = run.startTime || null;
    groups.set(key, metric);
  }

  const metrics = [...groups.values()].map((metric) => {
    const technicalRate = (metric.technicalSuccesses + 2) / (metric.attempts + 3);
    const qualityRate = metric.qualityEvaluated > 0
      ? (metric.qualityAccepted + 1) / (metric.qualityEvaluated + 2)
      : null;
    const meanScoreDelta = metric.scoreDeltaSamples > 0
      ? metric.scoreDeltaTotal / metric.scoreDeltaSamples
      : null;
    const meanDurationMs = metric.durationSamples > 0
      ? metric.durationTotalMs / metric.durationSamples
      : null;
    const rankScore = qualityRate === null
      ? technicalRate * 0.5
      : qualityRate * 0.75 + technicalRate * 0.25;
    const provider = enabled.get(metric.providerId);
    const eligible = !!provider && providerSupportsModel(provider, metric.model);
    const {
      scoreDeltaTotal, scoreDeltaSamples, durationTotalMs, durationSamples, ...publicMetric
    } = metric;
    return {
      ...publicMetric,
      technicalRate,
      qualityRate,
      meanScoreDelta,
      meanDurationMs,
      rankScore,
      eligible,
    };
  }).sort((a, b) => (
    b.rankScore - a.rankScore
    || b.qualityEvaluated - a.qualityEvaluated
    || b.attempts - a.attempts
    || (a.meanDurationMs ?? Infinity) - (b.meanDurationMs ?? Infinity)
  ));

  const recommendations = {};
  for (const metric of metrics) {
    if (
      !metric.eligible
      || metric.qualityEvaluated < MIN_QUALITY_SAMPLES
      || metric.qualityRate < MIN_QUALITY_RATE
    ) continue;
    recommendations[metric.pipelineStage] ||= {};
    if (recommendations[metric.pipelineStage][metric.pipelineRole]) continue;
    recommendations[metric.pipelineStage][metric.pipelineRole] = {
      providerOverride: metric.providerId,
      modelOverride: metric.model || undefined,
      effortOverride: metric.effort || undefined,
      samples: metric.qualityEvaluated,
      accepted: metric.qualityAccepted,
      rejected: metric.qualityRejected,
      rankScore: metric.rankScore,
    };
  }

  return { metrics, recommendations };
}

export async function getModelPerformanceReport() {
  const [{ runs }, providerResult] = await Promise.all([
    listRuns(MAX_RUNS, 0, 'all'),
    getAllProviders(),
  ]);
  const providers = Array.isArray(providerResult?.providers) ? providerResult.providers : [];
  const report = summarizeModelPerformance(runs, providers);
  return {
    ...report,
    evidenceRuns: report.metrics.reduce((sum, metric) => sum + metric.attempts, 0),
    minimumQualitySamples: MIN_QUALITY_SAMPLES,
    minimumQualityRate: MIN_QUALITY_RATE,
  };
}

// HTTP corrections require recorded series ownership; internal lifecycle callers
// already own their run ids and may annotate legacy evidence without this scope.
export async function recordModelOutcome(runId, patch = {}, seriesId) {
  const run = runId ? await getRun(runId) : null;
  if (!run || (seriesId !== undefined && run.seriesId !== seriesId)) return false;
  const scoreBefore = finiteOrNull(patch.scoreBefore);
  const scoreAfter = finiteOrNull(patch.scoreAfter);
  await patchRunMetadata(runId, {
    autopilotSystem: 'series',
    ...(patch.effort ? { effort: patch.effort } : {}),
    ...(patch.role ? { pipelineRole: patch.role } : {}),
    ...(patch.stage ? { pipelineStage: patch.stage } : {}),
    ...(patch.outcome ? { qualityOutcome: patch.outcome } : {}),
    ...(patch.target ? { qualityTarget: patch.target } : {}),
    ...(scoreBefore !== null ? { qualityScoreBefore: scoreBefore } : {}),
    ...(scoreAfter !== null ? { qualityScoreAfter: scoreAfter } : {}),
    ...(scoreBefore !== null && scoreAfter !== null ? { qualityScoreDelta: scoreAfter - scoreBefore } : {}),
    ...(patch.weightedBefore !== undefined ? { qualityWeightedBefore: finiteOrNull(patch.weightedBefore) } : {}),
    ...(patch.weightedAfter !== undefined ? { qualityWeightedAfter: finiteOrNull(patch.weightedAfter) } : {}),
    qualityEvaluatedAt: new Date().toISOString(),
  });
  return true;
}
