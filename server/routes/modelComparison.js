import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, modelComparisonImportSchema, modelComparisonDiscoverySchema } from '../lib/validation.js';
import { getModelComparison, importModelComparison } from '../services/modelComparison.js';
import { canRefreshModels } from '../lib/aiToolkit/internal/modelFetchers.js';
import { effortLevelsForProvider, filterSelectableModels } from '../lib/providerModels.js';

export function createModelComparisonRoutes(providerService) {
  const router = Router();
  router.get('/', asyncHandler(async (req, res) => {
    const [catalog, { providers }] = await Promise.all([getModelComparison(), providerService.getAllProviders()]);
    res.json({ ...catalog, inventory: providers.filter(p => p.enabled !== false).map(p => ({
      id: p.id, name: p.name, type: p.type, canDiscover: canRefreshModels(p),
      models: filterSelectableModels(p.models).filter(m => typeof m === 'string' && m).map(model => ({
        model, efforts: effortLevelsForProvider(p, model) || [],
      })),
    })) });
  }));
  // Explicit read-only catalog discovery: no model inference or provider writes.
  router.post('/discover', asyncHandler(async (req, res) => {
    const { providerId } = validateRequest(modelComparisonDiscoverySchema, req.body);
    const { providers } = await providerService.getAllProviders();
    const provider = providers.find(p => p.id === providerId && p.enabled !== false);
    if (!provider || !canRefreshModels(provider)) throw new ServerError('Provider is unavailable for model discovery', { status: 400 });
    const catalog = await providerService.fetchProviderModelCatalog(provider.id);
    if (!catalog) throw new ServerError('Provider model discovery returned no catalog', { status: 502 });
    res.json({ providerId: provider.id, models: filterSelectableModels(catalog.models).map(model => ({
      model, efforts: effortLevelsForProvider({ ...provider, models: catalog.models }, model) || [],
    })) });
  }));
  router.post('/import', asyncHandler(async (req, res) => {
    res.json(await importModelComparison(validateRequest(modelComparisonImportSchema, req.body)));
  }));
  return router;
}
