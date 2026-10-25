import { resolveExecutionOptions } from './executionOptions.js';
import { isCompositeProviderId } from './providerRef.js';

export function createProviderCrudService({
  loadProviders,
  saveProviders,
  buildProviderRecord,
  storeProviderRecords,
  withGatewayModelAccess,
  readProvider,
  resolveCompositeProvider = null,
  expandModePair,
  modeSiblingPayload,
  providerModeGroups,
  sharedModeUpdates,
  normalizeModelAccess,
}) {
  const normalizeClearedFields = (record) => {
    if (record.credentialBootstrap === null) delete record.credentialBootstrap;
    if (Object.hasOwn(record, 'modelAccess')) {
      const normalized = normalizeModelAccess(record.modelAccess);
      if (normalized) record.modelAccess = normalized;
      else delete record.modelAccess;
    }
  };

  async function executionSelection(record, providers) {
    if (!record?.executionSourceProviderId) return record;
    const id = record.executionSourceProviderId;
    const source = providers[id] || (typeof resolveCompositeProvider === 'function' && isCompositeProviderId(id)
      ? await resolveCompositeProvider(id) : null);
    if (!source || source.executionSourceProviderId) {
      return { ...record, enabled: false, unavailableReason: 'Execution selection source is unavailable' };
    }
    const resolved = { ...source, id: record.id, name: record.name,
      enabled: source.enabled !== false && record.enabled !== false,
      executionSourceProviderId: id,
      executionSelectionDefaults: source.executionOptions,
      executionSelectionOptions: record.executionOptions,
      executionOptions: resolveExecutionOptions({ source: 'provider', options: source.executionOptions },
        { source: 'selection', options: record.executionOptions }).requested };
    if (source.apiKey) Object.defineProperty(resolved, 'apiKey', { value: source.apiKey, enumerable: false, configurable: true });
    return resolved;
  }

  return {
    async getAllProviders() {
      const data = await loadProviders();
      return {
        activeProvider: data.activeProvider,
        providers: await Promise.all(Object.values(data.providers).map(async provider => withGatewayModelAccess(await executionSelection(provider, data.providers), data.providers)))
      };
    },

    async getProviderById(id) {
      const data = await loadProviders();
      const stored = readProvider(await executionSelection(data.providers[id], data.providers), data.providers);
      if (stored || typeof resolveCompositeProvider !== 'function' || !isCompositeProviderId(id)) return stored;
      return (await resolveCompositeProvider(id)) ?? null;
    },

    async getActiveProvider() {
      const data = await loadProviders();
      if (!data.activeProvider) return null;
      return readProvider(await executionSelection(data.providers[data.activeProvider], data.providers), data.providers);
    },

    async setActiveProvider(id) {
      const data = await loadProviders();
      if (!data.providers[id]) return null;
      data.activeProvider = id;
      await saveProviders(data);
      return executionSelection(data.providers[id], data.providers);
    },

    async createProvider(providerData) {
      const data = await loadProviders();
      const provider = buildProviderRecord(data.providers, providerData);
      storeProviderRecords(data, [provider]);
      await saveProviders(data);
      return provider;
    },

    async createProviderModes(providerData) {
      const split = expandModePair(providerData);
      if (!split) throw new Error('createProviderModes requires a modes declaration');

      const data = await loadProviders();
      const created = split.map(modeData => buildProviderRecord(data.providers, modeData));
      storeProviderRecords(data, created);
      await saveProviders(data);
      return created;
    },

    async createProviderTuiMode(id, tuiOverrides = {}) {
      const data = await loadProviders();
      const stored = data.providers[id];
      if (!stored) return null;
      if (stored.type !== 'cli') throw new Error('Only a CLI provider can gain a TUI mode');

      const created = buildProviderRecord(data.providers, modeSiblingPayload(stored, 'tui', tuiOverrides));
      storeProviderRecords(data, [created]);
      await saveProviders(data);
      return created;
    },

    async updateProvider(id, updates) {
      const data = await loadProviders();
      if (!data.providers[id]) return null;

      if (data.providers[id].executionSourceProviderId && Object.keys(updates).some(key => !['name', 'enabled', 'executionOptions'].includes(key))) {
        const error = new Error('Edit the source provider to change this execution selection route.');
        error.status = 400;
        throw error;
      }
      const provider = { ...data.providers[id], ...updates, id };
      normalizeClearedFields(provider);

      const group = providerModeGroups(Object.values(data.providers)).find(modes => modes.some(mode => mode.id === id));
      data.providers[id] = provider;
      for (const sibling of group || []) {
        if (sibling.id === id) continue;
        Object.assign(sibling, sharedModeUpdates(updates));
        normalizeClearedFields(sibling);
      }
      await saveProviders(data);
      return provider;
    },

    async applyProviderPatches(patches) {
      const data = await loadProviders();
      const applied = [];
      for (const [id, updates] of Object.entries(patches || {})) {
        if (!data.providers[id]) continue;
        data.providers[id] = { ...data.providers[id], ...updates, id };
        applied.push(id);
      }
      if (applied.length > 0) await saveProviders(data);
      return applied;
    },

    async deleteProvider(id) {
      const data = await loadProviders();
      if (!data.providers[id]) return false;

      const group = providerModeGroups(Object.values(data.providers)).find(modes => modes.some(mode => mode.id === id));
      const removed = (group || []).map(mode => mode.id);
      for (const modeId of removed) delete data.providers[modeId];

      if (removed.includes(data.activeProvider)) {
        const remaining = Object.keys(data.providers).filter((key) => !(data.providers[key].executionSourceProviderId || data.providers[key].executionSelectionRoot));
        data.activeProvider = remaining.length > 0 ? remaining[0] : null;
      }

      await saveProviders(data);
      return true;
    },
  };
}
