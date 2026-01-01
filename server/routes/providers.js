import { Router } from 'express';
import * as providers from '../services/providers.js';

const router = Router();

// GET /api/providers - List all providers
router.get('/', async (req, res, next) => {
  const data = await providers.getAllProviders().catch(next);
  if (data) res.json(data);
});

// GET /api/providers/active - Get active provider
router.get('/active', async (req, res, next) => {
  const provider = await providers.getActiveProvider().catch(next);
  if (provider === undefined) return;
  res.json(provider);
});

// PUT /api/providers/active - Set active provider
router.put('/active', async (req, res, next) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Provider ID required', code: 'MISSING_ID' });
  }

  const provider = await providers.setActiveProvider(id).catch(next);
  if (provider === undefined) return;

  if (!provider) {
    return res.status(404).json({ error: 'Provider not found', code: 'NOT_FOUND' });
  }

  res.json(provider);
});

// GET /api/providers/:id - Get provider by ID
router.get('/:id', async (req, res, next) => {
  const provider = await providers.getProviderById(req.params.id).catch(next);
  if (provider === undefined) return;

  if (!provider) {
    return res.status(404).json({ error: 'Provider not found', code: 'NOT_FOUND' });
  }

  res.json(provider);
});

// POST /api/providers - Create new provider
router.post('/', async (req, res, next) => {
  const { name, type } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required', code: 'VALIDATION_ERROR' });
  }

  if (!type || !['cli', 'api'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "cli" or "api"', code: 'VALIDATION_ERROR' });
  }

  const provider = await providers.createProvider(req.body).catch(err => {
    if (err.message.includes('already exists')) {
      res.status(409).json({ error: err.message, code: 'CONFLICT' });
      return undefined;
    }
    next(err);
    return undefined;
  });

  if (provider === undefined) return;
  res.status(201).json(provider);
});

// PUT /api/providers/:id - Update provider
router.put('/:id', async (req, res, next) => {
  const provider = await providers.updateProvider(req.params.id, req.body).catch(next);
  if (provider === undefined) return;

  if (!provider) {
    return res.status(404).json({ error: 'Provider not found', code: 'NOT_FOUND' });
  }

  res.json(provider);
});

// DELETE /api/providers/:id - Delete provider
router.delete('/:id', async (req, res, next) => {
  const deleted = await providers.deleteProvider(req.params.id).catch(next);
  if (deleted === undefined) return;

  if (!deleted) {
    return res.status(404).json({ error: 'Provider not found', code: 'NOT_FOUND' });
  }

  res.status(204).send();
});

// POST /api/providers/:id/test - Test provider connectivity
router.post('/:id/test', async (req, res, next) => {
  const result = await providers.testProvider(req.params.id).catch(next);
  if (result === undefined) return;
  res.json(result);
});

// POST /api/providers/:id/refresh-models - Refresh models for API provider
router.post('/:id/refresh-models', async (req, res, next) => {
  const provider = await providers.refreshProviderModels(req.params.id).catch(next);
  if (provider === undefined) return;

  if (!provider) {
    return res.status(404).json({ error: 'Provider not found or not an API type', code: 'NOT_FOUND' });
  }

  res.json(provider);
});

export default router;
