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
import { autopilotStartSchema } from '../../lib/pipelineValidation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as autopilot from '../../services/pipeline/seriesAutopilot.js';
import {
  getModelPerformanceReport,
} from '../../services/pipeline/seriesAutopilot/modelPerformance.js';
import { mapServiceError } from './shared.js';

const router = Router();

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
