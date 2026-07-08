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
 *   GET  /series/:id/autopilot/status   → { autopilot }   (resume / paused UI)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest, MAX_CONVERGENCE_ROUNDS } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as autopilot from '../../services/pipeline/seriesAutopilot.js';
import { READINESS_GATES } from '../../services/pipeline/editorialScore.js';
import { mapServiceError, providerOverrideShape } from './shared.js';

const router = Router();

const autopilotStartSchema = z.object({
  ...providerOverrideShape,
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

router.get('/series/:id/autopilot/status', asyncHandler(async (req, res) => {
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json({ autopilot: series.autopilot || null, active: autopilot.isAutopilotActive(req.params.id) });
}));

export default router;
