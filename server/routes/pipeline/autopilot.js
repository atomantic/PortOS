/**
 * Pipeline Autopilot routes — full autonomous mode.
 *
 * Drives a whole series from its current state to story-ready by composing the
 * existing pipeline passes (server/services/pipeline/seriesAutopilot.js).
 *
 *   POST /series/:id/autopilot/start    → { runId, alreadyRunning, mode, sseUrl }
 *                                          (404 series missing; 409 cos domain off)
 *   GET  /series/:id/autopilot/progress → SSE (text/event-stream)
 *   POST /series/:id/autopilot/cancel   → { canceled }
 *                                          Emits a `cancel:acknowledged` SSE frame
 *                                          immediately; the active step/LLM call
 *                                          finishes before the terminal `canceled`
 *                                          frame (cooperative, between-step cancel).
 *   POST /series/:id/autopilot/pause    → { pauseRequested }
 *                                          Finishes the active step/transaction
 *                                          without stopping its provider run.
 *   GET  /series/:id/autopilot/status   → { autopilot, active, start, progress }
 *                                          (resume / paused UI; `start` is the
 *                                          in-flight run's start frame, which
 *                                          names its provider/model and carries
 *                                          the projected plan; `progress` is the
 *                                          run's position in that plan)
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
  recordModelOutcome,
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
  // Per-run reasoning effort (#3641). Soft, like the provider/model override: it
  // applies to stages with no `effort` pin of their own, and stageRunner clamps it
  // to the resolved provider ladder (dropping it entirely for a provider with no
  // effort control). Validated against the union of every accepted level across
  // effort-capable CLIs; '' (the UI "provider default" sentinel) means no override.
  effortOverride: effortOverrideSchema,
  // Optional per-run critic route. Creation/repair continues to use the run's
  // provider/model/effort above; judges, verification, analytical editorial
  // passes and pipeline diagnosis use this soft route instead. Exact stage pins
  // from Prompts still win. This is deliberately per-run so experimenting with a
  // lighter writer (for example Luna/max) does not globally repoint every series.
  judgeLlm: autopilotLlmRouteSchema.optional(),
  // Optional per-step routes for experiments and evidence-backed specialization.
  // A stage route wins over learned and run-wide routes for that role, while an
  // exact Prompts-stage pin remains authoritative inside stageRunner.
  stageLlm: autopilotStageLlmSchema.optional(),
  // Draft cover + all interior pages once a story is ready. Accepted now;
  // honored when VISUAL_DRAFT_ENABLED ships (Phase 2). Defaults true per the
  // product decision (whole-series, full draft visuals).
  includeVisual: z.boolean().optional().default(true),
  // 'auto' derives the terminal from the series targetFormat.
  target: z.enum(['auto', 'text', 'visual']).optional().default('auto'),
  // Create CoS tasks for capability gaps (Phase 3).
  fileGaps: z.boolean().optional().default(false),
  // Restrict a multi-format (comic+tv) series to one format's scripts for this
  // run — e.g. ['comic'] produces the comic draft and skips teleplay generation.
  // Absent/empty = author every format the series targets.
  targetFormats: z.array(z.enum(['comic', 'tv'])).optional(),
  // Per-run convergence bounds for the verify/review loops (0 = skip that gate).
  // When omitted, the autopilot falls back to the persisted
  // pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds,maxBeatContinuityRounds}
  // setting, then to the module default. Cap mirrors the settings schema so the
  // UI knob and a direct API call agree on the ceiling.
  maxArcVerifyRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxEditorialRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  maxBeatContinuityRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Foundation-quality gate (#2176). Per-run overrides for the pre-draft
  // foundation judge: `foundationGate` toggles it (defaults ON via the persisted
  // setting), `foundationThreshold` is the weighted [0,10] bar the foundation
  // must clear, `maxFoundationRounds` bounds the improve loop (0 = skip). When
  // omitted, each falls back to the persisted pipelineEditorialChecks setting,
  // then the module default. Round cap shares the convergence ceiling.
  foundationGate: z.boolean().optional(),
  foundationThreshold: z.number().min(0).max(10).optional(),
  maxFoundationRounds: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Per-run retry budget for a failed delegated child runner (beats/text) before
  // the autopilot escalates to a pause (#1574). 0 = single attempt, no retry.
  // Per-run only (no persisted default); falls back to MAX_CHILD_RETRIES. Shares
  // the convergence ceiling so a direct API call can't request an absurd budget.
  maxChildRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Per-run corrective-pass budget for the arc-verify regression guard (#3781):
  // how many times a reverted resolve round may be re-attempted from the restored
  // best state before the gate pauses for a human. 0 = revert and pause on the
  // first regression. Per-run only (no persisted default); falls back to
  // MAX_ARC_RESOLVE_RETRIES. Shares the convergence ceiling.
  maxArcResolveRetries: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Per-run cap on the arc-verify gate's per-finding isolation attempts (#3780):
  // once the corrective passes above are spent, how many residual findings the
  // gate may try ONE AT A TIME from the restored best state, keeping each patch
  // only if it closes its own target without worsening the set. 0 = no isolation
  // (revert and pause as before). Per-run only; when omitted the gate derives its
  // own budget from MAX_ARC_ISOLATION_CALLS and what a verification costs on this
  // series, and `maxArcResolveRetries: 0` opts out of isolation with it. Shares
  // the convergence ceiling so a direct API call can't request an absurd budget.
  maxArcIsolationAttempts: z.number().int().min(0).max(MAX_CONVERGENCE_ROUNDS).optional(),
  // Per-run editorial-check subset (#1575). When present, the editorial-checks
  // pass runs ONLY these check ids instead of all enabled checks — pilot one new
  // check, or skip an expensive one, without toggling the global enabled set.
  // Absent/empty = run every enabled check (the default). Per-run only (no
  // persisted default); unknown/disabled ids are silently ignored by the runner.
  editorialCheckIds: z.array(z.string().min(1)).optional(),
  // Per-run editorial-health readiness gate override (#1580). When omitted, the
  // gate falls back to the persisted pipelineEditorialChecks.readinessGate, then
  // the service default — so loosening (or tightening) the "manuscript clean" bar
  // for one run no longer requires editing global settings. Enum shares the
  // canonical READINESS_GATES set so the API and the scorer can't drift.
  readinessGate: z.enum(READINESS_GATES).optional(),
  // Per-run editorial-checks pause threshold override (#1613). When the checks
  // pass surfaces ≥ N high-severity findings, the run pauses for human review
  // instead of proceeding. When omitted, falls back to the persisted
  // pipelineEditorialChecks.checkFindingsPauseThreshold, then 0 (off). 0 disables
  // the gate for this run. No upper bound — a large N is effectively off.
  checkFindingsPauseThreshold: z.number().int().min(0).optional(),
  // Per-run pause-notification override (#1615). When the run pauses (budget,
  // findings, convergence, child failure), post an in-app notification with the
  // reason + a resume link so a paused run isn't missed until the user opens the
  // status page. When omitted, falls back to the persisted
  // pipelineEditorialChecks.notifyOnPause, then true (on by default — a zero-cost
  // informational signal). Set false to silence pause notifications for this run.
  notifyOnPause: z.boolean().optional(),
  // Autopilot → CD teaser deliverable (CDO Phase 3, #2185). When true, once every
  // comic issue is drafted the run mints + starts a Creative Director teaser video
  // per issue. Falls back to pipelineEditorialChecks.produceTeaser, then off.
  produceTeaser: z.boolean().optional(),
  // Unlock-everything pre-pass. When true, the run's first step clears every
  // lock this SERIES owns — the arc freeze + per-field arc locks, each volume's
  // lock, every issue stage lock, and the universe-canon entries this series
  // owns — so the autopilot can apply the fixes its editorial passes surface
  // instead of pausing on findings it isn't allowed to resolve. Canon owned by
  // (or shared with) another series in the same universe stays locked, and the
  // pass never deletes anything. UNLIKE every other option here there is NO
  // saved-setting fallback: it defaults to off on every run, so ticking it once
  // can't arm lock-clearing for an unattended scheduled run (see
  // seriesAutopilot/config.js#resolveAutopilotUnlockForRun).
  unlockForRun: z.boolean().optional(),
  // Iterate-to-quality revision loop (CWQE Phase 7, #2171). When true, after the
  // editorial-health gate the run cycles the weakest drafted issue through
  // adversarial cuts + a judge-gated keep/revert, stopping on plateau /
  // hedged-convergence / maxCycles. Falls back to the persisted
  // pipelineEditorialChecks.revision* setting, then off. minCycles floors the
  // stops; maxCycles is the cost ceiling; plateauDelta is the score-movement
  // convergence threshold. Caps share MAX_CONVERGENCE_ROUNDS so a direct API call
  // can't request an absurd cycle budget.
  revisionEnabled: z.boolean().optional(),
  revisionMinCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionMaxCycles: z.number().int().min(1).max(MAX_CONVERGENCE_ROUNDS).optional(),
  revisionPlateauDelta: z.number().min(0).max(10).optional(),
  // Pipeline self-improvement. When true, a run whose telemetry says the
  // AUTOMATION limped (a pause, a run-ending error, an editorial check that
  // threw, a retried child, a skipped step) spends one diagnosis call at its
  // terminal and, on a pipeline verdict, files a PortOS fix task.
  // That task always awaits human approval. Falls back to the persisted
  // pipelineEditorialChecks.selfImprove setting, then off.
  selfImprove: z.boolean().optional(),
  // Observing orchestrator. When true, the run watches its own telemetry step
  // by step and, when a step's fresh signals say the automation misbehaved,
  // spends a bounded diagnosis call and dispatches an AUTO-APPROVED PortOS fix
  // task — worktree-isolated, PR-opening, review-loop-then-merge, no human
  // gate (the explicit opt-in IS the consent; see seriesAutopilot/observer.js).
  // Supersedes the selfImprove terminal diagnosis when both are on. Falls back
  // to the persisted pipelineEditorialChecks.observer setting, then off.
  observer: z.boolean().optional(),
  // Learn from technical + editorial outcomes and use the best sufficiently
  // sampled eligible provider/model/effort for each step and role. Explicit
  // run choices and exact stage pins still win.
  autoSelectModels: z.boolean().optional(),
  // Force this run's provider/model/effort onto EVERY stage, ignoring the
  // per-stage pins from the Prompts page (see lib/stagePinPolicy.js). Falls back
  // to the persisted pipelineEditorialChecks.overrideStagePins setting, then off.
  overrideStagePins: z.boolean().optional(),
});

const modelOutcomeSchema = z.object({
  runId: z.string().uuid(),
  role: z.enum(['creative', 'judge']),
  stage: z.string().trim().min(1).max(80),
  outcome: z.enum(['accepted', 'rejected', 'valid', 'invalid']),
  effort: z.enum(EFFORT_LEVELS).optional(),
  target: z.string().trim().max(120).optional(),
  scoreBefore: z.number().finite().optional(),
  scoreAfter: z.number().finite().optional(),
  weightedBefore: z.number().finite().optional(),
  weightedAfter: z.number().finite().optional(),
}).strict();

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
    // The in-flight run's `start` frame (mode, target, resolved provider/model,
    // the projected plan), so a client attaching mid-run can describe a run it
    // never saw begin — SSE replays only the last frame. null when none active.
    start: autopilot.activeRunStart(req.params.id),
    // Where that run currently IS against the plan — completed counts per step,
    // the running step, and each gate's latest verification. Without it a panel
    // opened mid-run would draw every milestone as still pending.
    progress: autopilot.activeRunProgress(req.params.id),
  });
}));

router.get('/series/:id/autopilot/model-metrics', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await getModelPerformanceReport());
}));

// Operator correction/backfill tool: a technically successful run can still be
// rejected by a later quality gate. Recording that distinction is the core of
// the selector's evidence, and this endpoint lets an operator annotate historic
// runs or correct a misclassified outcome without editing run files by hand.
router.post('/series/:id/autopilot/model-outcomes', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(modelOutcomeSchema, req.body ?? {});
  const recorded = await recordModelOutcome(body.runId, body);
  if (!recorded) throw new ServerError('AI run not found', { status: 404, code: 'RUN_NOT_FOUND' });
  res.json({ success: true, runId: body.runId });
}));

export default router;
