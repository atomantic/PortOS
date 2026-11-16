/**
 * Pipeline Autopilot routes — full autonomous mode.
 *
 * Drives a whole series from its current state to story-ready by composing the
 * existing pipeline passes (server/services/pipeline/seriesAutopilot.js).
 *
 *   POST /series/:id/autopilot/start    → { runId, alreadyRunning, mode, sseUrl }
 *                                          (404 series missing; 409 cos domain off)
 *   GET  /series/:id/autopilot/progress → SSE (text/event-stream)
 *   POST /series/:id/autopilot/cancel   → { canceled }; emits `cancel:acknowledged` at once, the
 *                                          active step finishes before the terminal `canceled` frame
 *   POST /series/:id/autopilot/pause    → { pauseRequested }; finishes the active step without
 *                                          stopping its provider run
 *   GET  /series/:id/autopilot/status   → { autopilot, active, start, progress }
 *                                          (`start` = in-flight run's start frame, `progress` = its
 *                                          position in the projected plan)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest, MAX_CONVERGENCE_ROUNDS } from '../../lib/validation.js';
import { EFFORT_LEVELS } from '../../lib/providerModels.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as autopilot from '../../services/pipeline/seriesAutopilot.js';
import {
  getModelPerformanceReport,
} from '../../services/pipeline/seriesAutopilot/modelPerformance.js';
import { READINESS_GATES } from '../../services/pipeline/editorialScore.js';
import { mapServiceError, providerOverrideShape } from './shared.js';

const router = Router();

const effortOverrideSchema = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.enum(EFFORT_LEVELS).optional(),
);

const autopilotLlmRouteSchema = z.object({
  ...providerOverrideShape,
  effortOverride: effortOverrideSchema,
}).strict();

const autopilotStageLlmSchema = z.partialRecord(
  z.enum(seriesSvc.AUTOPILOT_LLM_STAGE_KINDS),
  z.object({
    creative: autopilotLlmRouteSchema.optional(),
    judge: autopilotLlmRouteSchema.optional(),
  }).strict(),
);

const autopilotStartSchema = z.object({
  ...providerOverrideShape,
  // Per-run reasoning effort: applies to stages with no `effort` pin; stageRunner clamps it to the
  // provider ladder. '' (UI "provider default") means no override.
  effortOverride: effortOverrideSchema,
  // Optional per-run critic route for judges, verification, analytical passes and diagnosis;
  // creation/repair keeps the run's provider/model/effort. Exact Prompts stage pins still win.
  judgeLlm: autopilotLlmRouteSchema.optional(),
  // Optional per-step routes; a stage route beats learned and run-wide routes, while an exact Prompts-stage pin stays authoritative in stageRunner.
  stageLlm: autopilotStageLlmSchema.optional(),
  // Draft cover + all interior pages once a story is ready; honored when VISUAL_DRAFT_ENABLED ships.
  includeVisual: z.boolean().optional().default(true),
  // 'auto' derives the terminal from the series targetFormat.
  target: z.enum(['auto', 'text', 'visual']).optional().default('auto'),
  // Create CoS tasks for capability gaps (Phase 3).
  fileGaps: z.boolean().optional().default(false),
  // Restrict a multi-format series to these formats' scripts (e.g. ['comic'] skips teleplay); absent/empty = all.
  targetFormats: z.array(z.enum(['comic', 'tv'])).optional(),
  // Bound production while retaining the full series plan as editorial context.
  productionScope: z.enum(['series', 'first-issue']).optional(),
  // Per-run convergence bounds for the verify/review loops (0 = skip that gate); omitted falls back to
  // pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds,maxBeatContinuityRounds}, then
  // the module default. Cap mirrors the settings schema.
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Foundation-quality gate: `foundationGate` toggles the pre-draft judge, `foundationThreshold` is
  // the weighted [0,10] bar, `maxFoundationRounds` bounds the improve loop (0 = skip). Each falls
  // back to the persisted pipelineEditorialChecks setting, then the module default.
  foundationGate: z.boolean().optional(),
  foundationThreshold: z.number().min(0).max(10).optional(),
  maxFoundationRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Retry budget for a failed delegated child runner before pausing (0 = single attempt).
  // Per-run only; falls back to MAX_CHILD_RETRIES. Shares the convergence ceiling.
  maxChildRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Corrective-pass budget for the arc-verify regression guard: re-attempts of a reverted resolve
  // round before pausing for a human (0 = revert and pause on first regression). Per-run only;
  // falls back to MAX_ARC_RESOLVE_RETRIES.
  maxArcResolveRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Cap on the arc-verify gate's one-at-a-time per-finding isolation attempts once corrective
  // passes are spent (each patch kept only if it closes its target without worsening the set).
  // 0 = no isolation. Per-run only; when omitted the gate derives a budget from
  // MAX_ARC_ISOLATION_CALLS, and `maxArcResolveRetries: 0` opts out of isolation too.
  maxArcIsolationAttempts: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Run ONLY these editorial check ids instead of all enabled ones; absent/empty = every enabled
  // check. Per-run only; unknown/disabled ids are silently ignored by the runner.
  editorialCheckIds: z.array(z.string().min(1)).optional(),
  // Readiness gate override; falls back to pipelineEditorialChecks.readinessGate, then the service
  // default. Shares READINESS_GATES so the API and scorer can't drift.
  readinessGate: z.enum(READINESS_GATES).optional(),
  // Pause for human review at >= N high-severity check findings. Falls back to
  // pipelineEditorialChecks.checkFindingsPauseThreshold, then 0 (off); no upper bound.
  checkFindingsPauseThreshold: z.number().int().min(0).optional(),
  // Post an in-app notification with a resume link when the run pauses. Falls back to
  // pipelineEditorialChecks.notifyOnPause, then true.
  notifyOnPause: z.boolean().optional(),
  // Mint + start a Creative Director teaser video per issue once every comic issue is drafted. Falls back to pipelineEditorialChecks.produceTeaser, then off.
  produceTeaser: z.boolean().optional(),
  // Unlock-everything pre-pass: clears every lock this SERIES owns (arc freeze, per-field arc
  // locks, volume, issue stage locks, owned universe-canon entries) so editorial fixes can apply.
  // Canon shared with another series stays locked; nothing is deleted. Unlike every other option
  // there is NO saved-setting fallback, so one tick can't arm lock-clearing for an unattended
  // scheduled run (seriesAutopilot/config.js#resolveAutopilotUnlockForRun).
  unlockForRun: z.boolean().optional(),
  // Iterate-to-quality revision loop (CWQE Phase 7): after the editorial-health gate, cycles the
  // weakest drafted issue through adversarial cuts + a judge-gated keep/revert until plateau,
  // hedged convergence or maxCycles (cost ceiling). Falls back to pipelineEditorialChecks.revision*,
  // then off. Caps share MAX_CONVERGENCE_ROUNDS.
  revisionEnabled: z.boolean().optional(),
  revisionMinCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionMaxCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionPlateauDelta: z.number().min(0).max(10).optional(),
  // Pipeline self-improvement: a run whose telemetry shows the AUTOMATION limped spends one
  // diagnosis call at its terminal and may file a PortOS fix task, always awaiting human
  // approval. Falls back to pipelineEditorialChecks.selfImprove, then off.
  selfImprove: z.boolean().optional(),
  // Observing orchestrator: watches its own telemetry step by step and, on misbehaving
  // automation, spends a bounded diagnosis call and dispatches an AUTO-APPROVED PortOS fix task
  // (worktree-isolated, no human gate; the explicit opt-in IS the consent, see
  // seriesAutopilot/observer.js). Supersedes selfImprove when both are on. Falls back to
  // pipelineEditorialChecks.observer, then off.
  observer: z.boolean().optional(),
  // Use the best sufficiently sampled provider/model/effort per step and role; explicit run choices and stage pins still win.
  autoSelectModels: z.boolean().optional(),
  // Force this run's provider/model/effort onto EVERY stage, ignoring Prompts-page pins
  // (lib/stagePinPolicy.js). Falls back to pipelineEditorialChecks.overrideStagePins, then off.
  overrideStagePins: z.boolean().optional(),
});


router.post('/series/:id/autopilot/start', asyncHandler(async (req, res) => {
  // 404 before we kick off if the series doesn't exist.
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(autopilotStartSchema, req.body ?? {});
  const result = await autopilot.startSeriesAutopilot(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  if (result.rejected) {
    throw new ServerError(
      'Autonomous spend is disabled — set the CoS auto-run domain to dry-run or execute to run autopilot.',
      { status: 409, code: 'PIPELINE_AUTOPILOT_DISABLED' },
    );
  }
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/autopilot/progress`,
  });
}));

router.get('/series/:id/autopilot/progress', (req, res) => {
  const attached = autopilot.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active autopilot run for this series', { status: 404 });
  }
});

router.post('/series/:id/autopilot/cancel', asyncHandler(async (req, res) => {
  const canceled = autopilot.cancelSeriesAutopilot(req.params.id);
  res.json({ canceled });
}));

router.post('/series/:id/autopilot/pause', asyncHandler(async (req, res) => {
  const pauseRequested = autopilot.pauseSeriesAutopilot(req.params.id);
  res.json({ pauseRequested });
}));

router.get('/series/:id/autopilot/status', asyncHandler(async (req, res) => {
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json({
    autopilot: series.autopilot || null,
    active: autopilot.isAutopilotActive(req.params.id),
    pauseRequested: autopilot.isAutopilotPauseRequested(req.params.id),
    // The in-flight run's `start` frame; SSE replays only the last frame, so a mid-run client needs it. null when none active.
    start: autopilot.activeRunStart(req.params.id),
    // Where the run is against the plan (step counts, running step, gate verifications); a panel opened mid-run would otherwise draw every milestone pending.
    progress: autopilot.activeRunProgress(req.params.id),
  });
}));

router.get('/series/:id/autopilot/model-metrics', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await getModelPerformanceReport());
}));

export default router;
