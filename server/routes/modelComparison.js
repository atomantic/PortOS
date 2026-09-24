import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, modelComparisonImportSchema } from '../lib/validation.js';
import { getPublicModelComparison, importModelComparison } from '../services/modelComparison.js';
import { getSelectableProviders } from '../services/providers.js';
import { effortLevelsForProvider, filterSelectableModels } from '../lib/providerModels.js';
import { gatewayIdForProvider } from '../lib/providerGateways.js';
import { buildModelComparisonComposite } from '../lib/modelComparisonComposite.js';

export function createModelComparisonRoutes(providerService = { getSelectableProviders }) {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    const [catalog, result] = await Promise.all([getPublicModelComparison(), providerService.getSelectableProviders()]);
    const inventory = result.providers.filter(provider => provider.enabled !== false).map(provider => ({
      id: provider.id, name: provider.name, gateway: gatewayIdForProvider(provider) || null,
      models: filterSelectableModels(provider.models).filter(model => typeof model === 'string' && model).map(model => ({
        model, efforts: effortLevelsForProvider(provider, model) || [],
      })),
    }));
    res.json({ ...catalog, inventory, composite: buildModelComparisonComposite(catalog.observations, inventory) });
  }));
  router.post('/import', asyncHandler(async (req, res) => {
    const result = await importModelComparison(validateRequest(modelComparisonImportSchema, req.body));
    res.json({ imported: req.body.observations.length, total: result.observations.length });
  }));
  return router;
}
