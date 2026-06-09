import { Router } from 'express';
import { ToolkitHttpError, defaultAsyncHandler } from '../internal/httpError.js';

export function createProvidersRoutes(providerService, options = {}) {
  const router = Router();
  // `asyncHandler`/`ServerError` are injected by the host (PortOS passes its
  // real ServerError + asyncHandler so thrown errors normalize into
  // `{ error, code, timestamp, context? }` and route to errorMiddleware).
  // Standalone, the toolkit's own defaults serialize the same envelope.
  const { asyncHandler = defaultAsyncHandler, ServerError = ToolkitHttpError } = options;

  router.get('/', asyncHandler(async (req, res) => {
    const data = await providerService.getAllProviders();
    res.json(data);
  }));

  router.get('/active', asyncHandler(async (req, res) => {
    const provider = await providerService.getActiveProvider();
    res.json(provider);
  }));

  router.put('/active', asyncHandler(async (req, res) => {
    const { id } = req.body;
    if (!id) {
      throw new ServerError('Provider ID required', { status: 400 });
    }

    const provider = await providerService.setActiveProvider(id);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(provider);
  }));

  router.get('/samples', asyncHandler(async (req, res) => {
    const providers = await providerService.getSampleProviders();
    res.json({ providers });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.getProviderById(req.params.id);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(provider);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { name, type } = req.body;

    if (!name) {
      throw new ServerError('Name is required', { status: 400 });
    }

    if (!type || !['cli', 'api', 'tui'].includes(type)) {
      throw new ServerError('Type must be "cli", "api", or "tui"', { status: 400 });
    }

    const provider = await providerService.createProvider(req.body);
    res.status(201).json(provider);
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.updateProvider(req.params.id, req.body);

    if (!provider) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.json(provider);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleted = await providerService.deleteProvider(req.params.id);

    if (!deleted) {
      throw new ServerError('Provider not found', { status: 404 });
    }

    res.status(204).send();
  }));

  router.post('/:id/test', asyncHandler(async (req, res) => {
    const result = await providerService.testProvider(req.params.id);
    res.json(result);
  }));

  router.post('/:id/refresh-models', asyncHandler(async (req, res) => {
    const provider = await providerService.refreshProviderModels(req.params.id);

    if (!provider) {
      throw new ServerError('Provider not found or not an API type', { status: 404 });
    }

    res.json(provider);
  }));

  return router;
}
