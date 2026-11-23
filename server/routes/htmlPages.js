import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { htmlPagesPageParamsSchema, htmlPagesRunSchema } from '../lib/htmlPagesValidation.js';
import { listRuns, listSelectableModels, pageFile, readRun, removeRun, resumeRun, startRuns } from '../services/htmlPages/index.js';

const router = Router();

// Registered ahead of `/runs/:id` so the literal path is not read as a run id.
router.get('/models', asyncHandler(async (_req, res) => {
  res.json(await listSelectableModels());
}));

router.get('/runs', asyncHandler(async (_req, res) => {
  res.json(await listRuns());
}));

// The only path that reaches a model: an explicit request naming the models and page count.
router.post('/runs', asyncHandler(async (req, res) => {
  const input = validateRequest(htmlPagesRunSchema, req.body);
  res.status(202).json(await startRuns(input));
}));

router.get('/runs/:id', asyncHandler(async (req, res) => {
  res.json(await readRun(req.params.id));
}));

// One page as a file download, from data/html-pages (written from the record first if it is missing).
router.get('/runs/:id/pages/:index/file', asyncHandler(async (req, res) => {
  const { id, index } = validateRequest(htmlPagesPageParamsSchema, req.params);
  const { path, fileName } = await pageFile(id, index);
  res.download(path, fileName);
}));

// Where that file is on this machine, for "Copy file path"; writes it from the record if it is missing.
router.get('/runs/:id/pages/:index/path', asyncHandler(async (req, res) => {
  const { id, index } = validateRequest(htmlPagesPageParamsSchema, req.params);
  res.json(await pageFile(id, index));
}));

// Re-queues a failed run from its first unfinished page: an explicit request, like starting one.
router.post('/runs/:id/resume', asyncHandler(async (req, res) => {
  res.status(202).json(await resumeRun(req.params.id));
}));

router.delete('/runs/:id', asyncHandler(async (req, res) => {
  res.json(await removeRun(req.params.id));
}));

export default router;
