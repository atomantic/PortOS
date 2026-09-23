import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, modelComparisonImportSchema, modelComparisonDiscoverySchema, modelComparisonSyncSchema } from '../lib/validation.js';
import { getModelComparison, importModelComparison } from '../services/modelComparison.js';
import { hasArtificialAnalysisKey, syncArtificialAnalysisCatalog } from '../services/artificialAnalysis.js';
import { syncOpenRouterCatalog, syncOpenRouterEndpointCatalog } from '../services/openrouterBenchmarks.js';
import { syncEpochAiCatalog } from '../services/epochAiBenchmarks.js';
import { syncSwebenchCatalog } from '../services/swebenchBenchmarks.js';
import { syncLiveCodeBenchCatalog } from '../services/livecodebenchBenchmarks.js';
import { canRefreshModels } from '../lib/aiToolkit/internal/modelFetchers.js';
import { effortLevelsForProvider, filterSelectableModels } from '../lib/providerModels.js';
import { catalogSlugForProviderModel } from '../lib/comparisonModelScope.js';
import { applyModelAccess } from '../lib/aiToolkit/internal/modelAccess.js';

// The sync sources the page offers, keyed by the route parameter. The AA key
// presence travels separately on GET — never the key itself.
const BENCHMARK_SYNC_SOURCES = Object.freeze({
  'artificial-analysis': { label: 'Artificial Analysis', requiresKey: true, sync: syncArtificialAnalysisCatalog },
  openrouter: { label: 'OpenRouter routed pricing', requiresKey: false, sync: () => syncOpenRouterCatalog() },
  'openrouter-endpoints': { label: 'OpenRouter serving endpoints', requiresKey: false, sync: () => syncOpenRouterEndpointCatalog() },
  'epoch-ai': { label: 'Epoch AI benchmarks', requiresKey: false, sync: () => syncEpochAiCatalog() },
  swebench: { label: 'SWE-bench leaderboards', requiresKey: false, sync: () => syncSwebenchCatalog() },
  livecodebench: { label: 'LiveCodeBench', requiresKey: false, sync: () => syncLiveCodeBenchCatalog() },
});

// The endpoint id plus the benchmark-index name it normalizes to. Both travel,
// because the page needs them for different things: the executable id labels
// the row, and the slug is what a catalog observation is keyed by. Deriving the
// slug client-side would be a second copy of the normalization rules, which is
// how the coverage list came to report "Needs research" for models the chart
// was already plotting.
const inventoryModel = (provider, model) => ({
  model, efforts: effortLevelsForProvider(provider, model) || [], catalogModel: catalogSlugForProviderModel(model) || null,
});

export function createModelComparisonRoutes(providerService) {
  const router = Router();
  router.get('/', asyncHandler(async (req, res) => {
    const [catalog, { providers }, artificialAnalysisKeyConfigured] = await Promise.all([
      getModelComparison(), providerService.getAllProviders(), hasArtificialAnalysisKey(),
    ]);
    // Scoped by the same model-access policy the provider pickers apply
    // (aiToolkit/internal/modelAccess.js), so the chart's default pills and its
    // coverage list describe the models this install can actually dispatch —
    // not a vendor's whole advertised catalog. Without this the chart would
    // plot, and offer to research, models an unentitled account cannot run.
    const inventory = providers.filter(p => p.enabled !== false).map(applyModelAccess).map(p => ({
      id: p.id, name: p.name, type: p.type, canDiscover: canRefreshModels(p),
      models: filterSelectableModels(p.models).filter(m => typeof m === 'string' && m).map(model => inventoryModel(p, model)),
    }));
    // Benchmark rows the user can act on: the chart defaults to the models their
    // own providers can dispatch, with the rest of the index one click away.
    res.json({
      // Read back off the inventory rather than re-normalizing every id.
      ...catalog, inventory, availableModels: [...new Set(inventory.flatMap(p => p.models.map(m => m.catalogModel).filter(Boolean)))].sort(),
      // Presence only, never the key — the page skips its key prompt when set.
      artificialAnalysisKeyConfigured,
      syncSources: Object.entries(BENCHMARK_SYNC_SOURCES).map(([id, source]) => ({ id, label: source.label, requiresKey: source.requiresKey })),
    });
  }));
  // Explicit read-only catalog discovery: no model inference or provider writes.
  router.post('/discover', asyncHandler(async (req, res) => {
    const { providerId } = validateRequest(modelComparisonDiscoverySchema, req.body);
    const { providers } = await providerService.getAllProviders();
    const provider = providers.find(p => p.id === providerId && p.enabled !== false);
    if (!provider || !canRefreshModels(provider)) throw new ServerError('Provider is unavailable for model discovery', { status: 400 });
    const catalog = await providerService.fetchProviderModelCatalog(provider.id);
    if (!catalog) throw new ServerError('Provider model discovery returned no catalog', { status: 502 });
    // A freshly probed catalog is scoped the same way a stored one is: the
    // policy describes the ACCOUNT, so it applies to whatever the upstream just
    // advertised, not only to what happens to be on the record.
    const discovered = applyModelAccess({ ...provider, models: catalog.models });
    res.json({ providerId: provider.id, models: filterSelectableModels(discovered.models).map(model => inventoryModel(discovered, model)) });
  }));
  router.post('/import', asyncHandler(async (req, res) => {
    res.json(await importModelComparison(validateRequest(modelComparisonImportSchema, req.body)));
  }));
  router.post('/sync-aa', asyncHandler(async (req, res) => {
    const { apiKey } = validateRequest(modelComparisonSyncSchema, req.body || {});
    res.json(await syncArtificialAnalysisCatalog({ apiKey }));
  }));
  // Generalized benchmark source sync. /sync-aa stays as a back-compat alias —
  // other installs' UIs and scripts call it directly.
  router.post('/sync/:source', asyncHandler(async (req, res) => {
    const source = BENCHMARK_SYNC_SOURCES[req.params.source];
    if (!source) throw new ServerError(`Unknown benchmark sync source: ${req.params.source}`, { status: 404 });
    const { apiKey } = validateRequest(modelComparisonSyncSchema, req.body || {});
    res.json(await source.sync({ apiKey }));
  }));
  return router;
}
