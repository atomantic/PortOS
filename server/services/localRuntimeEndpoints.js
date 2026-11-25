/**
 * Where each local runtime's OpenAI-compatible endpoint is, which API key it is served behind, and
 * which models it serves. Shared by the Performance assessments and the Local LLM Playground so the
 * Playground does not inherit the assessments service's closure. Listing only reads `/v1/models` and
 * disk; nothing here generates, so it is safe on page load.
 */

import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import {
  ASSESSABLE_RUNTIMES,
  LOCAL_RUNTIMES,
  MANAGED_ASSESSMENT_BACKENDS,
  isEndpointRuntime,
  localRuntimeKind,
} from '../lib/localProviderRuntime.js';
import { listProviders } from './provider/providers.js';
import { getLlamaServerEndpoint } from './llamaServerManager.js';
import { getMtplxServerEndpoint, getMtplxServerStatus } from './mtplxServerManager.js';
import { getSlotstreamServerEndpoint } from './slotstreamServerManager.js';
import { getSpecDecodePresetStatus } from './specDecodeModels.js';
import { listManagedBackendModels } from './localLlm.js';

/**
 * Where this runtime's OpenAI-compatible API actually is right now. PM2-managed daemons can move
 * off the shipped default port, so ask the manager rather than probing a stale default.
 */
export async function runtimeEndpoint(runtime) {
  // Endpoint-only accessors: the `get*Status` calls pay for a network probe and a pm2 logs subprocess.
  // Performance page load only to learn a port number.
  const resolver = { llama: getLlamaServerEndpoint, mtplx: getMtplxServerEndpoint, slotstream: getSlotstreamServerEndpoint }[runtime];
  if (resolver) {
    const endpoint = await resolver().catch(() => null);
    if (endpoint) return endpoint;
  }
  return LOCAL_RUNTIMES[runtime]?.defaultBaseUrl || null;
}

/**
 * The API key a bare endpoint runtime is served behind, or `''` for an unauthenticated loopback
 * daemon (a key-gated vLLM answers 401 otherwise). Resolved like `providerReadiness.js`, keyed on the
 * same `localRuntimeKind` classifier.
 */
export async function runtimeApiKey(runtime) {
  // `listProviders`: `getAllProviders` resolves an envelope, not an array.
  // behind VLLM_API_KEY then 401'd on every sample.
  const match = (await listProviders())
    .find((p) => localRuntimeKind(p) === runtime && typeof p?.apiKey === 'string' && p.apiKey !== '');
  return match?.apiKey || '';
}

/**
 * What PortOS knows is installed for a runtime WITHOUT asking the daemon. Only consulted when the
 * live probe FAILED. Runtimes PortOS holds no catalog for (vLLM, SGLang) return `[]`.
 */
export async function durableRuntimeModels(runtime) {
  if (runtime === 'llama') {
    // The preset id IS the alias PortOS starts it under, so it matches /v1/models.
    const presets = await getSpecDecodePresetStatus().catch(() => []);
    return presets
      .filter((preset) => preset?.model?.exists)
      .map((preset) => ({ id: preset.id, params: null, quantization: preset.model.quant ?? null }));
  }
  if (runtime === 'mtplx') {
    const status = await getMtplxServerStatus().catch(() => null);
    return (status?.cachedModels || []).map((id) => ({ id, params: null, quantization: null }));
  }
  return [];
}

/**
 * Models this runtime can be measured against, plus why the list failed when it did.
 *
 * A managed backend has a durable catalog on disk, so its list survives the daemon being down. An
 * endpoint runtime only knows what `GET /v1/models` reports, so a stopped daemon is an ERROR, never
 * an empty catalog.
 * @returns {Promise<{models: Array<object>|null, error: string|null}>}
 *   `models: null` means the list could not be read; `[]` means it was read and
 *   is genuinely empty.
 */
export async function listRuntimeModels(runtime, { durable = true } = {}) {
  // `listManagedBackendModels` carries the "empty vs unreadable" sentinel for these backends.
  if (MANAGED_ASSESSMENT_BACKENDS.includes(runtime)) return listManagedBackendModels(runtime);

  const endpoint = await runtimeEndpoint(runtime);
  if (!endpoint) return { models: null, error: 'no endpoint is configured for this runtime', offline: true };

  // Daemon down is common and fixable: fall back to disk and mark `offline` so consumers know
  // nothing can run until the runtime starts.
  // `durable: false` skips the disk fallback: MTPLX's status sizes its cache directory, which can take tens of
  // seconds, and a caller that cannot run a model on a stopped daemon has no use for the list.
  const offlineListing = async (error) => {
    const models = durable ? await durableRuntimeModels(runtime).catch(() => []) : [];
    return { models: models.length ? models : null, error, offline: true };
  };

  const probe = await probeOpenAiModels(endpoint, { timeoutMs: 2500, apiKey: await runtimeApiKey(runtime) });
  if (!probe.reachable) return offlineListing(`not reachable at ${endpoint} (${probe.error})`);
  if (!probe.models) return offlineListing(probe.error || 'model listing was not readable');
  // Endpoint runtimes report ids only; `null` params leave the capability axis unscored.
  return { models: probe.models.map((id) => ({ id, params: null, quantization: null })), error: null };
}

/**
 * One row per bare-endpoint runtime for the Playground's model picker. Reads model lists only
 * (`/v1/models` and disk): it never generates, so the page can call it on load.
 * `offline` means the daemon did not answer; `models` is then empty (the disk catalog is skipped on purpose,
 * see `listRuntimeModels`), because nothing can run on a stopped daemon.
 */
export async function listEndpointRuntimeModels() {
  const runtimes = ASSESSABLE_RUNTIMES.filter(isEndpointRuntime);
  return Promise.all(runtimes.map(async (id) => {
    const listing = await listRuntimeModels(id, { durable: false }).catch((err) => ({ models: null, error: err?.message || 'model listing failed', offline: true }));
    return {
      id,
      label: LOCAL_RUNTIMES[id]?.label || id,
      models: (listing.models || []).map((m) => ({ id: m.id })),
      offline: listing.offline === true,
      error: listing.error || null,
    };
  }));
}
