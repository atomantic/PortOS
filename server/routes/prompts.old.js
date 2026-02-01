import { Router } from 'express';
import * as promptService from '../services/promptService.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/prompts - List all stages
router.get('/', asyncHandler(async (req, res) => {
  const stages = promptService.getStages();
  res.json({ stages });
}));

// GET /api/prompts/variables - List all variables
router.get('/variables', asyncHandler(async (req, res) => {
  const variables = promptService.getVariables();
  res.json({ variables });
}));

// GET /api/prompts/variables/:key - Get a variable
router.get('/variables/:key', asyncHandler(async (req, res) => {
  const variable = promptService.getVariable(req.params.key);
  if (!variable) {
    throw new ServerError('Variable not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ key: req.params.key, ...variable });
}));

// POST /api/prompts/variables - Create a variable
router.post('/variables', asyncHandler(async (req, res) => {
  const { key, name, category, content } = req.body;
  if (!key || !content) {
    throw new ServerError('key and content are required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  await promptService.createVariable(key, { name, category, content });
  res.json({ success: true, key });
}));

// PUT /api/prompts/variables/:key - Update a variable
router.put('/variables/:key', asyncHandler(async (req, res) => {
  const { name, category, content } = req.body;
  await promptService.updateVariable(req.params.key, { name, category, content });
  res.json({ success: true });
}));

// DELETE /api/prompts/variables/:key - Delete a variable
router.delete('/variables/:key', asyncHandler(async (req, res) => {
  await promptService.deleteVariable(req.params.key);
  res.json({ success: true });
}));

// GET /api/prompts/:stage - Get stage with template
router.get('/:stage', asyncHandler(async (req, res) => {
  const stage = promptService.getStage(req.params.stage);
  if (!stage) {
    throw new ServerError('Stage not found', { status: 404, code: 'NOT_FOUND' });
  }
  const template = await promptService.getStageTemplate(req.params.stage);
  res.json({ ...stage, template });
}));

// PUT /api/prompts/:stage - Update stage config and/or template
router.put('/:stage', asyncHandler(async (req, res) => {
  const { template, ...config } = req.body;

  if (Object.keys(config).length > 0) {
    await promptService.updateStageConfig(req.params.stage, config);
  }
  if (template !== undefined) {
    await promptService.updateStageTemplate(req.params.stage, template);
  }
  res.json({ success: true });
}));

// POST /api/prompts/:stage/preview - Preview compiled prompt
router.post('/:stage/preview', asyncHandler(async (req, res) => {
  const { testData = {} } = req.body;
  const preview = await promptService.previewPrompt(req.params.stage, testData);
  res.json({ preview });
}));

// POST /api/prompts/reload - Reload prompts from disk
router.post('/reload', asyncHandler(async (req, res) => {
  await promptService.loadPrompts();
  res.json({ success: true });
}));

export default router;
