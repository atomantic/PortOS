/**
 * Whether the Voice LLM is resident in memory on its local runtime (Ollama, LM Studio or llama.cpp), so the call UI can tell a cold model load apart from thinking.
 *
 * Read-only: every probe inspects runtime state and never loads, warms or evicts a model. Hosted and unrecognized
 * providers answer `unknown`, which the UI renders as no badge rather than a guess.
 */

import { getProviderById } from '../provider/providers.js';
import { localRuntimeKind } from '../../lib/modelPinMembership.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

const PROBE_TIMEOUT_MS = 1500;

/** @typedef {'loaded'|'loading'|'unloaded'|'offline'|'unknown'} VoiceLlmResidencyState */

const originOf = (apiBase) => String(apiBase || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

// Ollama reports `name:tag`; a pin without a tag means `:latest`.
const sameModel = (loadedId, model) => {
  const withTag = (id) => (String(id).includes(':') ? String(id) : `${id}:latest`);
  return loadedId === model || withTag(loadedId) === withTag(model);
};

const residentState = (models, error, model) => {
  if (error) return 'unknown';
  return models.some((m) => sameModel(m.id ?? m.name, model)) ? 'loaded' : 'unloaded';
};

// llama-server answers /health with 503 while it loads weights, and /props carries `is_sleeping` once
// `--sleep-idle-seconds` released them. It serves one model, so the probe does not compare ids.
const llamaState = async (origin, apiKey) => {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const health = await fetchWithTimeout(`${origin}/health`, { headers }, PROBE_TIMEOUT_MS).catch(() => null);
  if (!health) return 'offline';
  if (health.status === 503) return 'loading';
  if (!health.ok) return 'unknown';
  const props = await fetchWithTimeout(`${origin}/props`, { headers }, PROBE_TIMEOUT_MS)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  if (props?.is_sleeping === true) return 'unloaded';
  return 'loaded';
};

/**
 * @param {{ providerId: string, apiBase: string, apiKey?: string, model: string }} target
 * @returns {Promise<{ state: VoiceLlmResidencyState, runtime: string|null, model: string }>}
 */
export async function probeVoiceLlmResidency({ providerId, apiBase, apiKey = '', model }) {
  const provider = await getProviderById(providerId).catch(() => null);
  const runtime = localRuntimeKind(provider ?? { id: providerId, endpoint: apiBase });
  const origin = originOf(apiBase);
  let state = 'unknown';
  if (model && runtime === 'ollama') {
    const ollama = await import('../ollamaManager.js');
    const { models, error } = await ollama.getLoadedModelsAt(origin, { timeout: PROBE_TIMEOUT_MS });
    state = residentState(models, error, model);
  } else if (model && runtime === 'lmstudio') {
    const lmStudio = await import('../lmStudioManager.js');
    const { models, error } = await lmStudio.getLoadedModelsAt(origin);
    state = residentState(models, error, model);
  } else if (runtime === 'llama') {
    state = await llamaState(origin, apiKey);
  }
  return { state, runtime, model: model || null };
}
