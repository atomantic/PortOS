import { Router } from 'express';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import * as loopsService from '../services/loops.js';
import { createLoopSchema } from '../lib/validation.js';

// updateLoop accepts a subset of createLoopSchema fields (name/prompt/interval/cwd/providerId/timeout)
const updateLoopSchema = createLoopSchema.pick({
  name: true,
  prompt: true,
  interval: true,
  cwd: true,
  providerId: true,
  timeout: true,
}).partial();

const router = Router();

// GET /api/loops
router.get('/', asyncHandler(async (req, res) => {
  const loops = await loopsService.getLoops();
  res.json(loops);
}));

// GET /api/loops/providers
router.get('/providers', asyncHandler(async (req, res) => {
  const data = await loopsService.getAvailableProviders();
  res.json(data);
}));

// GET /api/loops/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const loop = await loopsService.getLoop(req.params.id);
  if (!loop) throw new ServerError('Loop not found', { status: 404, code: 'NOT_FOUND' });
  res.json(loop);
}));

// POST /api/loops
router.post('/', asyncHandler(async (req, res) => {
  const parsedLoop = createLoopSchema.safeParse(req.body);
  if (!parsedLoop.success) failValidation(parsedLoop);
  const { prompt, interval, name, cwd, providerId, timeout, runImmediately } = parsedLoop.data;
  const loop = await loopsService.createLoop({
    prompt, interval, name, cwd, providerId, timeout,
    runImmediately: runImmediately !== false
  });
  res.status(201).json(loop);
}));

// PUT /api/loops/:id
router.put('/:id', asyncHandler(async (req, res) => {
  const parsed = updateLoopSchema.safeParse(req.body);
  if (!parsed.success) failValidation(parsed);
  const loop = await loopsService.updateLoop(req.params.id, parsed.data);
  res.json(loop);
}));

// POST /api/loops/:id/stop
router.post('/:id/stop', asyncHandler(async (req, res) => {
  await loopsService.stopLoop(req.params.id);
  res.json({ status: 'stopped' });
}));

// POST /api/loops/:id/resume
router.post('/:id/resume', asyncHandler(async (req, res) => {
  const loop = await loopsService.resumeLoop(req.params.id);
  res.json(loop);
}));

// POST /api/loops/:id/trigger
router.post('/:id/trigger', asyncHandler(async (req, res) => {
  const result = await loopsService.triggerLoop(req.params.id);
  res.json(result);
}));

// DELETE /api/loops/:id
router.delete('/:id', asyncHandler(async (req, res) => {
  await loopsService.deleteLoop(req.params.id);
  res.status(204).end();
}));

export default router;
