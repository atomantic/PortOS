import { AsyncLocalStorage } from 'node:async_hooks';
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
  if (own) {
    const result = { ...provider, modelAccessEffective: own, modelAccessSource: 'own' };
    const key = Object.getOwnPropertyDescriptor(provider, 'apiKey');
    if (key && !key.enumerable) Object.defineProperty(result, 'apiKey', key);
    return result;
  }
  const gateway = gatewayForProvider(provider);
  const inherited = gateway ? normalizeModelAccess(providers?.[gateway.id]?.modelAccess) : null;
  if (!inherited) return provider;
  const result = { ...provider, modelAccessEffective: inherited, modelAccessSource: gateway.id };
  const key = Object.getOwnPropertyDescriptor(provider, 'apiKey');
  if (key && !key.enumerable) Object.defineProperty(result, 'apiKey', key);
  return result;
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
    cliProbeTimeouts: config.cliProbeTimeouts,
  });
  const service = { ...crud, ...catalog };
  const writes = new AsyncLocalStorage();
  let tail = Promise.resolve();
  for (const name of ['setActiveProvider', 'createProvider', 'createProviderModes', 'createProviderTuiMode',
    'updateProvider', 'applyProviderPatches', 'deleteProvider', 'refreshProviderModels', 'refreshProviderModelsBatch']) {
    const operation = service[name];
    service[name] = function (...args) {
      if (writes.getStore()?.active) return operation.apply(service, args);
      const queued = tail.then(() => {
        const lease = { active: true };
        return writes.run(lease, async () => {
          try { return await operation.apply(service, args); }
          finally { lease.active = false; }
        });
      });
      tail = queued.catch(() => {});
      return queued;
    };
  }
  return service;
}
