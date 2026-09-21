/**
 * Retire the shipped NVIDIA Kimi K2.5 preset now that NVIDIA NIM is the
 * general provider for that endpoint and its broader catalog.
 *
 * Fresh installs no longer receive this record from data.reference. Existing
 * installs are handled conservatively: remove only the untouched shipped
 * preset, while preserving a record the user enabled, keyed, renamed,
 * selected as active, customized, or referenced as a fallback.
 *
 * The graph reconciliation that follows migration removes the deleted route;
 * it deliberately keeps an emptied connection available for explicit service
 * cleanup, matching the provider-graph contract for user-owned connections.
 */

import { isDeepStrictEqual } from 'node:util';
import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const PROVIDERS_REL_PATH = 'data/providers.json';
const PROVIDER_ID = 'nvidia-kimi';
const GRAPH_FIELDS = new Set(['harnessId', 'method', 'serviceId', 'servicePlan']);

// The provider existed in two equivalent shipped shapes: older reference
// seeds omitted fallbackProvider and secretEnvVars, while the normalized
// generator emitted both. Normalize only those known default omissions before
// comparing; any other extra or changed field is user-owned and blocks removal.
const SHIPPED_PROVIDER = {
  id: PROVIDER_ID,
  name: 'NVIDIA Kimi K2.5',
  type: 'api',
  endpoint: 'https://integrate.api.nvidia.com/v1',
  apiKey: '',
  models: ['moonshotai/kimi-k2.5', 'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-thinking'],
  defaultModel: 'moonshotai/kimi-k2.5',
  lightModel: 'moonshotai/kimi-k2-instruct',
  mediumModel: 'moonshotai/kimi-k2.5',
  heavyModel: 'moonshotai/kimi-k2-thinking',
  fallbackProvider: null,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const comparableProvider = (provider) => {
  const comparable = Object.fromEntries(Object.entries(provider).filter(([key]) => !GRAPH_FIELDS.has(key)));
  if (!Object.hasOwn(comparable, 'fallbackProvider')) comparable.fallbackProvider = null;
  if (!Object.hasOwn(comparable, 'secretEnvVars')) comparable.secretEnvVars = [];
  return comparable;
};

export const isUntouchedShippedNvidiaKimi = (provider) => (
  provider && typeof provider === 'object' && !Array.isArray(provider)
    && isDeepStrictEqual(comparableProvider(provider), SHIPPED_PROVIDER)
);

const isReferenced = (config, providers) => (
  config?.activeProvider === PROVIDER_ID
  || Object.values(providers).some((provider) => provider?.fallbackProvider === PROVIDER_ID)
);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping NVIDIA Kimi retirement`);
      else if (doc.reason === 'unreadable') console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${doc.err.message})`);
      else console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return { ok: false, reason: doc.reason, removed: false };
    }

    if (!Object.hasOwn(doc.providers, PROVIDER_ID)) return { ok: true, reason: 'absent', removed: false };
    const provider = doc.providers[PROVIDER_ID];
    if (!isUntouchedShippedNvidiaKimi(provider) || isReferenced(doc.config, doc.providers)) {
      return { ok: true, reason: 'customized', removed: false };
    }

    delete doc.providers[PROVIDER_ID];
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`🧹 ${PROVIDERS_REL_PATH}: removed retired NVIDIA Kimi K2.5 preset`);
    return { ok: true, reason: 'removed', removed: true };
  },
};
