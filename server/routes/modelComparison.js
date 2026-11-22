import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { getPublicModelComparison, importModelComparison } from '../services/modelComparison.js';
import { getSelectableProviders } from '../services/provider/providers.js';
import { antigravityBaseModels, effortLevelsForProvider, filterSelectableModels, isAntigravityProvider } from '../lib/provider/providerModels.js';
import { localRuntimeKind } from '../lib/modelPinMembership.js';
import { gatewayIdForProvider } from '../lib/provider/providerGateways.js';
import { buildModelComparisonComposite, CURRENT_COMPARISON_ANCHOR } from '../lib/modelComparisonComposite.js';
import { modelComparisonImportSchema } from '../lib/modelComparisonValidation.js';
import { captureLiveEnvironments, loadAssessments } from '../services/localModelAssessmentStore.js';
import { localSpeedFromAssessments } from '../lib/localModelAssessment.js';

export function createModelComparisonRoutes(providerService = { getSelectableProviders }) {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    // Disk-only read; an unreadable store reports no assessments, which leaves local speed unplotted.
    const [catalog, result, assessments] = await Promise.all([getPublicModelComparison(), providerService.getSelectableProviders(), loadAssessments()]);
    const inventory = result.providers.filter(provider => provider.enabled !== false).map(provider => ({
      id: provider.id, name: provider.name, gateway: gatewayIdForProvider(provider) || null,
      localInference: provider.servicePlan === 'local' || (!provider.servicePlan && !gatewayIdForProvider(provider) && Boolean(localRuntimeKind(provider))),
      runtime: localRuntimeKind(provider) || null,
      models: filterSelectableModels(isAntigravityProvider(provider) ? antigravityBaseModels(provider.models) : provider.models).filter(model => typeof model === 'string' && model).map(model => ({
        model, efforts: effortLevelsForProvider(provider, model) || [],
      })),
    }));
    // Staleness needs the live machine state; the backend-version probe is one cached loopback GET.
    const liveEnvironments = await captureLiveEnvironments({ backends: [...new Set(assessments.map(a => a?.backend).filter(Boolean))] });
    const localSpeed = localSpeedFromAssessments(assessments, liveEnvironments);
    const composite = buildModelComparisonComposite(catalog.observations, inventory, undefined, { localSpeed });
    const currentComposite = buildModelComparisonComposite(catalog.observations, inventory, CURRENT_COMPARISON_ANCHOR, { localSpeed });
    res.json({ ...catalog, inventory, composite, currentComposite });
  }));
  router.post('/import', asyncHandler(async (req, res) => {
    const result = await importModelComparison(validateRequest(modelComparisonImportSchema, req.body));
    res.json({ imported: req.body.observations.length, total: result.observations.length });
  }));
  return router;
}
