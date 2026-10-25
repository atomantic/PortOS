/** Retained run history and survivor controls; training launch is retired. */
import { Router } from 'express';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, sendErrorResponse, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { assertSafeFilename } from '../lib/fileUtils.js';
import { refuseRetiredTraining, TRAINING_RETIRED_MESSAGE } from '../lib/retiredLoraTraining.js';
import { attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';
import { cancel as cancelTrainer, getRunRequired, listCheckpoints, listRuns, listSamples, promoteCheckpoint, runSamplesDir } from '../services/loraTraining/index.js';

const router = Router();
router.use((req, _res, next) => {
  if (req.method !== 'GET' && !(req.method === 'POST' && /^\/runs\/[^/]+\/(cancel|promote-checkpoint)$/.test(req.path))) refuseRetiredTraining();
  next();
});
// Explicit tombstones preserve legacy route authorization and return 410.
router.post('/runs', refuseRetiredTraining);
router.post('/runs/:id/resume', refuseRetiredTraining);
router.get('/status', (_req, res) => res.json({ retired: true, message: TRAINING_RETIRED_MESSAGE, runtimes: { mflux: { ready: false }, flux2: { ready: false } } }));
const listQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  characterId: z.string().max(128).optional(), datasetId: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
router.get('/runs', asyncHandler(async (req, res) => res.json(await listRuns(validateRequest(listQuerySchema, req.query)))));
router.get('/runs/:id', asyncHandler(async (req, res) => res.json(await getRunRequired(req.params.id))));
router.get('/runs/:id/events', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  if (!run.jobId || !attachSseClient(run.jobId, res)) throw new ServerError('No live stream for this retained run', { status: 404, code: 'NOT_FOUND' });
}));
router.post('/runs/:id/cancel', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  const result = run.jobId ? await cancelJob(run.jobId) : { ok: false, code: 'NOT_FOUND', error: 'Run has no queue job' };
  if (!result.ok && result.code === 'NOT_FOUND' && cancelTrainer(run.jobId || run.id)) {
    res.json({ ok: true, status: 'canceling', orphan: true });
    return;
  }
  if (!result.ok) throw new ServerError(result.error || 'Cancel failed', { status: !run.jobId ? 409 : result.code === 'NOT_FOUND' ? 404 : 409, code: !run.jobId ? 'ALREADY_TERMINAL' : result.code });
  res.json(result);
}));
router.get('/runs/:id/checkpoints', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id); res.json(await listCheckpoints(req.params.id));
}));
const promoteSchema = z.object({ step: z.coerce.number().int().min(0) });
router.post('/runs/:id/promote-checkpoint', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id);
  const { step } = validateRequest(promoteSchema, req.body);
  res.json(await promoteCheckpoint(req.params.id, step));
}));
router.get('/runs/:id/samples', asyncHandler(async (req, res) => {
  await getRunRequired(req.params.id); res.json(await listSamples(req.params.id));
}));
router.get('/runs/:id/samples/:filename', asyncHandler(async (req, res) => {
  const run = await getRunRequired(req.params.id);
  assertSafeFilename(req.params.filename, { extensions: ['.png'], subject: 'sample filename' });
  res.sendFile(join(runSamplesDir(run.id), req.params.filename), err => {
    if (!err) return;
    if (err.code === 'ECONNABORTED' || res.headersSent) { res.destroy(); return; }
    console.error(`❌ Sample send failed [${req.params.id}/${req.params.filename}]: ${err.message}`);
    sendErrorResponse(res, new ServerError('Sample not found', { status: 404 }));
  });
}));
export default router;
