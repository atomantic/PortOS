import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createProviderCrudService } from './internal/providerCrudService.js';
import { createProviderCatalogService } from './internal/providerCatalogService.js';
import { createProviderServiceState } from './internal/providerServiceState.js';
import { expandModePair, modeSiblingPayload, providerModeGroups, sharedModeUpdates } from './internal/providerModes.js';
import { gatewayForProvider } from './internal/gateways.js';
import { normalizeModelAccess } from './internal/modelAccess.js';

export { isOllamaBackedProvider } from './internal/ollamaBacked.js';
export { isGatewayBackedProvider } from './internal/gateways.js';
export { ollamaRefreshGroupKey, canRefreshModels } from './internal/modelFetchers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_PATH = join(__dirname, 'defaults/providers.sample.json');

function withGatewayApiKey(provider, providers) {
  const gateway = gatewayForProvider(provider);
  const siblingKey = gateway ? providers?.[gateway.id]?.apiKey : null;
  if (!gateway || provider.apiKey || !siblingKey) return provider;
  const executionProvider = { ...provider };
  Object.defineProperty(executionProvider, 'apiKey', {
    value: siblingKey,
    enumerable: false,
    configurable: true,
  });
  return executionProvider;
}

function withGatewayModelAccess(provider, providers) {
  if (!provider || typeof provider !== 'object') return provider;
  const own = normalizeModelAccess(provider.modelAccess);
  if (own) return { ...provider, modelAccessEffective: own, modelAccessSource: 'own' };
  const gateway = gatewayForProvider(provider);
  const inherited = gateway ? normalizeModelAccess(providers?.[gateway.id]?.modelAccess) : null;
  if (!inherited) return provider;
  return { ...provider, modelAccessEffective: inherited, modelAccessSource: gateway.id };
}

const readProvider = (provider, providers) => (provider
  ? withGatewayApiKey(withGatewayModelAccess(provider, providers), providers)
  : null);

export function createProviderService(config = {}) {
  const state = createProviderServiceState(config);
  const {
    loadProviders,
    saveProviders,
    buildProviderRecord,
    storeProviderRecords,
    sampleFile,
    cachedModelIds,
    resolveCompositeProvider,
  } = state;
  const crud = createProviderCrudService({
    loadProviders,
    saveProviders,
    buildProviderRecord,
    storeProviderRecords,
    withGatewayModelAccess,
    readProvider,
    resolveCompositeProvider,
    expandModePair,
    modeSiblingPayload,
    providerModeGroups,
    sharedModeUpdates,
    normalizeModelAccess,
  });
  const catalog = createProviderCatalogService({
    loadProviders,
    saveProviders,
    withGatewayApiKey,
    cachedModelIds,
    sampleFile,
    defaultSamplePath: DEFAULT_SAMPLE_PATH,
  });
  return { ...crud, ...catalog };
}
