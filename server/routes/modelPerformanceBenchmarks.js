import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, modelComparisonDiscoverySchema, modelComparisonBenchmarkRunSchema } from '../lib/validation.js';
import { getPortosModelBenchmarkObservations } from '../services/modelComparison.js';
import { canRefreshModels } from '../lib/aiToolkit/internal/modelFetchers.js';
import { effortLevelsForProvider, filterSelectableModels } from '../lib/providerModels.js';
import { applyModelAccess } from '../lib/aiToolkit/internal/modelAccess.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { isFreeProvider } from '../lib/modelPricing.js';
import { isCodexTextTransportEnabled } from '../lib/codexTurn.js';
import { modelComparisonBilling, runPortosModelBenchmark } from '../services/portosModelBenchmarks.js';

const eligibleBenchmarkProvider = provider => Boolean(familyForProvider(provider) || isFreeProvider(provider));
const supportsBenchmarkText = provider => provider.type === 'api' || isCodexTextTransportEnabled(provider);
const toProviders = result => Array.isArray(result?.providers) ? result.providers : Object.values(result?.providers || {});
const inventoryModel = (provider, model) => ({ model, efforts: effortLevelsForProvider(provider, model) || [] });

/** User-triggered provider discovery and PortOS task runs for Models → Performance. */
export function createModelPerformanceBenchmarkRoutes(providerService) {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const [catalog, providerResult] = await Promise.all([
      getPortosModelBenchmarkObservations(),
      providerService.getAllProviders(),
    ]);
    const inventory = toProviders(providerResult)
      .filter(provider => provider.enabled !== false && eligibleBenchmarkProvider(provider))
      .map(applyModelAccess)
      .map(provider => {
        const canBenchmark = supportsBenchmarkText(provider);
        return {
          id: provider.id,
          name: provider.name,
          type: provider.type,
          billing: modelComparisonBilling(provider),
          canBenchmark,
          benchmarkUnavailableReason: canBenchmark ? null : 'This provider needs a tool-free text transport before PortOS can benchmark it safely.',
          canDiscover: canRefreshModels(provider),
          models: filterSelectableModels(provider.models)
            .filter(model => typeof model === 'string' && model)
            .map(model => inventoryModel(provider, model)),
        };
      });
    res.json({ ...catalog, inventory });
  }));

  router.post('/discover', asyncHandler(async (req, res) => {
    const { providerId } = validateRequest(modelComparisonDiscoverySchema, req.body);
    const provider = toProviders(await providerService.getAllProviders())
      .find(item => item.id === providerId && item.enabled !== false);
    if (!provider || !eligibleBenchmarkProvider(provider) || !canRefreshModels(provider)) {
      throw new ServerError('Provider is unavailable for model discovery', { status: 400 });
    }
    const catalog = await providerService.fetchProviderModelCatalog(provider.id);
    if (!catalog) throw new ServerError('Provider model discovery returned no catalog', { status: 502 });
    const discovered = applyModelAccess({ ...provider, models: catalog.models });
    res.json({
      providerId: provider.id,
      models: filterSelectableModels(discovered.models).map(model => inventoryModel(discovered, model)),
    });
  }));

  router.post('/run', asyncHandler(async (req, res) => {
    const { providerId, model, effort = null } = validateRequest(modelComparisonBenchmarkRunSchema, req.body);
    const provider = toProviders(await providerService.getAllProviders())
      .find(item => item.id === providerId && item.enabled !== false);
    if (!provider || !eligibleBenchmarkProvider(provider)) {
      throw new ServerError('Provider is unavailable for PortOS benchmarking', { status: 400 });
    }
    if (!supportsBenchmarkText(provider)) {
      throw new ServerError('This provider does not have a tool-free text transport for benchmarking', { status: 400 });
    }
    const scopedProvider = applyModelAccess(provider);
    let modelAvailable = filterSelectableModels(scopedProvider.models).includes(model);
    // Explicit discovery is read-only; a discovered model must still be usable
    // when the user starts the subsequent run.
    if (!modelAvailable && canRefreshModels(provider)) {
      const catalog = await providerService.fetchProviderModelCatalog(provider.id);
      if (Array.isArray(catalog?.models)) {
        const refreshed = applyModelAccess({ ...provider, models: catalog.models });
        modelAvailable = filterSelectableModels(refreshed.models).includes(model);
      }
    }
    if (!modelAvailable) {
      throw new ServerError('Model is not available to this provider account', { status: 400 });
    }
    if (effort) {
      const efforts = effortLevelsForProvider(provider, model) || [];
      if (!efforts.includes(effort)) {
        throw new ServerError(`Effort is unavailable for this model${efforts.length ? `; choose ${efforts.join(', ')}` : ''}`, { status: 400 });
      }
    }
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    res.json(await runPortosModelBenchmark({ provider, model, effort, signal: controller.signal }));
  }));

  return router;
}
