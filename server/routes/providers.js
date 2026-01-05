import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import * as providers from '../services/providers.js';

const router = Router();

// GET /api/providers - List all providers
router.get('/', asyncHandler(async (req, res) => {
  const data = await providers.getAllProviders();
  res.json(data);
}));

// GET /api/providers/active - Get active provider
router.get('/active', asyncHandler(async (req, res) => {
  const provider = await providers.getActiveProvider();
  res.json(provider);
}));

// PUT /api/providers/active - Set active provider
router.put('/active', asyncHandler(async (req, res) => {
  const { id } = req.body;
  if (!id) {
    throw new ServerError('Provider ID required', { status: 400, code: 'MISSING_ID' });
  }

  const provider = await providers.setActiveProvider(id);

  if (!provider) {
    throw new ServerError('Provider not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(provider);
}));

// GET /api/providers/:id - Get provider by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const provider = await providers.getProviderById(req.params.id);

  if (!provider) {
    throw new ServerError('Provider not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(provider);
}));

// POST /api/providers - Create new provider
router.post('/', asyncHandler(async (req, res) => {
  const { name, type } = req.body;

  if (!name) {
    throw new ServerError('Name is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (!type || !['cli', 'api'].includes(type)) {
    throw new ServerError('Type must be "cli" or "api"', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const provider = await providers.createProvider(req.body);
  res.status(201).json(provider);
}));

// PUT /api/providers/:id - Update provider
router.put('/:id', asyncHandler(async (req, res) => {
  const provider = await providers.updateProvider(req.params.id, req.body);

  if (!provider) {
    throw new ServerError('Provider not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(provider);
}));

// DELETE /api/providers/:id - Delete provider
router.delete('/:id', asyncHandler(async (req, res) => {
  const deleted = await providers.deleteProvider(req.params.id);

  if (!deleted) {
    throw new ServerError('Provider not found', { status: 404, code: 'NOT_FOUND' });
  }

  res.status(204).send();
}));

// POST /api/providers/:id/test - Test provider connectivity
router.post('/:id/test', asyncHandler(async (req, res) => {
  const result = await providers.testProvider(req.params.id);
  res.json(result);
}));

// POST /api/providers/:id/refresh-models - Refresh models for API provider
router.post('/:id/refresh-models', asyncHandler(async (req, res) => {
  const provider = await providers.refreshProviderModels(req.params.id);

  if (!provider) {
    throw new ServerError('Provider not found or not an API type', { status: 404, code: 'NOT_FOUND' });
  }

  res.json(provider);
}));

export default router;
