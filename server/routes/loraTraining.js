/**
 * LoRA training run routes — `/api/lora-training`.
 *
 * Run lifecycle (start/list/detail/cancel/delete), per-run SSE progress
 * (delegated to the media-job queue's stream for the run's jobId), sample
 * image serving, and a runtime-readiness status endpoint for the UI.
 */

import { Router } from 'express';
import { rm } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, sendErrorResponse, ServerError } from '../lib/errorHandler.js';
import { startTrainingRunSchema, validateRequest } from '../lib/validation.js';
import { assertSafeFilename } from '../lib/fileUtils.js';
import { resolveFlux2Python, isFlux2VenvHealthy, resolveMfluxPython } from '../lib/pythonSetup.js';
import { getSettings } from '../services/settings.js';
import { attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';
import {
  clearDatasetForDeletedLora,
  deleteRun,
  getRunRequired,
  isMfluxTrainAvailable,
  listCheckpoints,
  listRuns,
  listSamples,
  promoteCheckpoint,
  resumeTrainingRun,
  runDir,
  runSamplesDir,
  startTrainingRun,
} from '../services/loraTraining/index.js';
import { TRAINING_DEFAULTS } from '../services/loraTraining/runtimes.js';
import { deleteLora } from '../services/loras.js';

const router = Router();

// Engine readiness + defaults — drives the launch panel's enable/disable
// state and the params form's initial values. Both engines train FLUX.2
// Klein LoRAs; mflux (MLX-native) is preferred when its trainer ships
// with the user's install, the torch venv is the fallback.
router.get('/status', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  // Prefer the configured image-gen Python when it ships mflux-train, else the
  // auto-discovered dedicated ~/.portos/venv-mflux — so the panel reports mflux
  // ready even when the user never set pythonPath (fresh dedicated-venv install).
  const mfluxPython = resolveMfluxPython(settings?.imageGen?.local?.pythonPath || null);
  const flux2Python = resolveFlux2Python();
  res.json({
    runtimes: {
      mflux: { ready: isMfluxTrainAvailable(mfluxPython), pythonPath: mfluxPython },
      flux2: { ready: !!flux2Python && await isFlux2VenvHealthy(), venvPython: flux2Python },
    },
    defaults: { ...TRAINING_DEFAULTS, ...(settings?.loraTraining?.defaults || {}) },
  });
}));

router.post('/runs', asyncHandler(async (req, res) => {
  const body = validateRequest(startTrainingRunSchema, req.body);
  res.status(202).json(await startTrainingRun(body));
}));

const listQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  characterId: z.string().max(128).optional(),
  datasetId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get('/runs', asyncHandler(async (req, res) => {
  const query = validateRequest(listQuerySchema, req.query);
  res.json(await listRuns(query));
}));

router.get('/runs/:id', asyncHandler(async (req, res) => {
  res.json(await getRunRequired(req.params.id));
}));

// Live progress — the run's SSE stream IS the media-job stream. The queue
// synthesizes a terminal frame for archived jobs, so late attaches after
// completion still resolve.
router.get('/runs/:id/events', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  if (!run.jobId || !attachSseClient(run.jobId, res)) {
    throw new ServerError(`No live stream for run ${req.params.id} (status: ${run.status})`, {
      status: 404, code: 'NOT_FOUND',
    });
  }
}));

router.post('/runs/:id/cancel', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  if (!run.jobId) {
    throw new ServerError('Run has no job to cancel', { status: 409, code: 'ALREADY_TERMINAL' });
  }
  const result = await cancelJob(run.jobId);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 409;
    throw new ServerError(result.error || 'Cancel failed', { status, code: result.code });
  }
  res.json(result);
}));

// Resume a failed/canceled run from its latest checkpoint — re-enqueues a job
// against the SAME run id (mflux bakes the output path into the checkpoint, so
// the resumed trainer must write back into the original run dir). 202-shaped.
router.post('/runs/:id/resume', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id); // 404 if the run is unknown
  res.status(202).json(await resumeTrainingRun(req.params.id));
}));

router.delete('/runs/:id', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  if (['queued', 'running'].includes(run.status)) {
    throw new ServerError('Cancel the run before deleting it', { status: 409, code: 'RUN_ACTIVE' });
  }
  // Artifact dir is server-derived from the run id (uuid) — confined under
  // PATHS.trainingRuns by construction.
  await rm(runDir(run.id), { recursive: true, force: true });
  if (req.query.deleteLora === 'true' && run.output?.loraFilename) {
    await deleteLora(run.output.loraFilename).catch((err) => {
      console.log(`⚠️ trained LoRA delete skipped: ${err?.message}`);
    });
    // Reset the owning dataset off 'trained' so it can't keep advertising the
    // subject as trained against the file we just deleted.
    await clearDatasetForDeletedLora(run, run.output.loraFilename);
  }
  res.json(await deleteRun(run.id));
}));

// Checkpoint picker: list every saved checkpoint with its step, loss, and
// preview thumbnail so the user can promote one by eye. Loss is shown but is
// NOT a quality ranking — it was anti-correlated with quality on the
// divergence run this feature was built for (see checkpoints.js).
router.get('/runs/:id/checkpoints', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id); // 404 if the run is unknown
  res.json(await listCheckpoints(req.params.id));
}));

const promoteSchema = z.object({ step: z.coerce.number().int().min(0) });
router.post('/runs/:id/promote-checkpoint', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id);
  const { step } = validateRequest(promoteSchema, req.body);
  res.json(await promoteCheckpoint(req.params.id, step));
}));

// Mid-training sample timeline (step + thumbnail URL) — seeds the live
// progress gallery so a reload mid-run shows every sample so far, not just
// the ones streamed after re-subscribing. Registered before the
// `/samples/:filename` serve route (which needs the extra path segment).
router.get('/runs/:id/samples', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id); // 404 if the run is unknown
  res.json(await listSamples(req.params.id));
}));

router.get('/runs/:id/samples/:filename', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  assertSafeFilename(req.params.filename, { extensions: ['.png'], subject: 'sample filename' });
  // The sendFile callback fires outside asyncHandler's catch (the handler's
  // promise has already resolved), so a throw here would have nothing to bubble
  // to — build the standard envelope directly instead.
  res.sendFile(join(runSamplesDir(run.id), req.params.filename), (err) => {
    if (!err) return;
    // Client cancelled (routine when the gallery unmounts an <img>) or the body
    // was already streaming when the read failed — nothing left to say, just
    // drop the socket rather than logging a false failure.
    if (err.code === 'ECONNABORTED' || res.headersSent) {
      res.destroy();
      return;
    }
    // A real I/O failure (EACCES/EIO) reads the same as a missing file to the
    // client — log the cause so it isn't invisible server-side.
    console.error(`❌ Sample send failed [${req.params.id}/${req.params.filename}]: ${err.message}`);
    sendErrorResponse(res, new ServerError('Sample not found', { status: 404 }));
  });
}));

export default router;
