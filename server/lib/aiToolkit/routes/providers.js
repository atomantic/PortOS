import { Router } from 'express';

export function createProvidersRoutes(providerService, options = {}) {
  const router = Router();
  const { asyncHandler = (fn) => fn } = options;

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
      return res.status(400).json({ error: 'Provider ID required' });
    }

    const provider = await providerService.setActiveProvider(id);

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
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
      return res.status(404).json({ error: 'Provider not found' });
    }

    res.json(provider);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { name, type } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!type || !['cli', 'api', 'tui'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "cli", "api", or "tui"' });
    }

    const provider = await providerService.createProvider(req.body);
    res.status(201).json(provider);
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
    const provider = await providerService.updateProvider(req.params.id, req.body);

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    res.json(provider);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const deleted = await providerService.deleteProvider(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Provider not found' });
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
      return res.status(404).json({ error: 'Provider not found or not an API type' });
    }

    res.json(provider);
  }));

  return router;
}
