/**
 * Self-heal a wrong local-model configuration.
 *
 * When a run targets an Ollama or LM Studio model that isn't actually installed
 * (typically a stale or mis-typed provider default), surfacing a raw "model not
 * found" is a dead end on a single-user box — the fix is mechanical: pick a real
 * installed model, repoint the provider so future runs use it, tell the user
 * what changed, and let the caller retry. This module owns that recovery so any
 * local-backend call path can adopt it instead of throwing.
 *
 * Only applies to the two local backends (Ollama / LM Studio). Remote/API and
 * CLI providers return null from `localBackendForProvider` and are left alone —
 * we can't enumerate their installed models, and their "model not found" is a
 * config error the user must fix deliberately.
 */

import { emitLog } from './cosEvents.js';
import { updateProvider } from './providers.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import * as ollamaManager from './ollamaManager.js';
import * as lmStudioManager from './lmStudioManager.js';
import { recommendEditorialModel, isEmbeddingModel } from '../lib/localModelHeuristics.js';

// Default OpenAI-compatible ports for the two local backends. An endpoint-only
// provider (no id/name) pointed at one of these on the local instance maps to
// that backend.
const BACKEND_DEFAULT_PORT = { '11434': 'ollama', '1234': 'lmstudio' };

// A backend "model not found" — Ollama answers 404 `model "x" not found, try
// pulling it first`; LM Studio answers `model "x" not found`/`unknown model`.
// Deliberately does NOT match "no models loaded" (a load problem with its own
// recovery in aiProvider.js — auto-loading a downloaded model, not swapping the
// configured one).
const MODEL_NOT_FOUND_RE = /model\s*['"]?[\w./:-]*['"]?\s*(?:not found|does not exist|is not (?:found|installed|available))|not found, try pulling|unknown model|no such model/i;
const NO_MODELS_LOADED_RE = /no models loaded/i;

/**
 * Which local backend (if any) a provider maps to. Matches by id/name first
 * (`ollama` / `lmstudio`), then by an endpoint pointing at the backend's default
 * port on THIS machine's local instance — using the same local-host logic as
 * the endpoint guard, so every loopback / bind-all spelling resolves.
 * @returns {'ollama'|'lmstudio'|null}
 */
export function localBackendForProvider(provider) {
  if (ollamaManager.isOllamaProvider(provider)) return 'ollama';
  if (provider?.id === 'lmstudio' || /lm[\s-]?studio/i.test(provider?.name || '')) return 'lmstudio';
  const port = localEndpointPort(provider?.endpoint);
  return port ? (BACKEND_DEFAULT_PORT[port] || null) : null;
}

// The port of a provider endpoint when it points at THIS machine's local
// instance (any loopback / bind-all host spelling); null otherwise — so a
// LAN/Tailscale peer on the same port is NOT mistaken for a local backend.
function localEndpointPort(endpoint) {
  const cleaned = String(endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  try {
    const u = new URL(cleaned);
    if (!isLocalInstanceHost(u.hostname)) return null;
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch { return null; }
}

/**
 * True when an error string is a backend "configured model isn't installed"
 * failure (vs. "no models loaded", which is a separate recovery).
 */
export function isModelNotFoundError(text) {
  const s = String(text || '');
  if (NO_MODELS_LOADED_RE.test(s)) return false;
  return MODEL_NOT_FOUND_RE.test(s);
}

/**
 * Pick the best installed model to fall back to. Prefers the editorial
 * recommender (family + size ranking, already drops embeddings/media weights);
 * if it finds nothing usable, takes the first non-embedding model, then any —
 * embeddings can't serve a chat completion, so never auto-pick one.
 * @returns {string|null}
 */
export function chooseFallbackModel(models) {
  const recommended = recommendEditorialModel(models);
  if (recommended?.id) return recommended.id;
  const usable = (models || []).find((m) => m?.id && !isEmbeddingModel(m.id));
  return usable?.id || (models || [])[0]?.id || null;
}

/**
 * The provider patch that repoints a wrong config onto an installed model:
 * fixes the default when it's the missing model or otherwise not installed,
 * repoints any tier slot pointing at an uninstalled model, and ensures the
 * fallback is selectable in the model list. Pure — no I/O — so it's unit-tested.
 */
export function computeProviderPatch(provider, installedIds, fallback, requestedModel) {
  const installed = new Set(installedIds);
  const patch = {};
  if (provider?.defaultModel === requestedModel || !installed.has(provider?.defaultModel)) {
    patch.defaultModel = fallback;
  }
  for (const tier of ['lightModel', 'mediumModel', 'heavyModel']) {
    const v = provider?.[tier];
    if (v && !installed.has(v)) patch[tier] = fallback;
  }
  const models = Array.isArray(provider?.models) ? provider.models : [];
  if (!models.includes(fallback)) patch.models = [...models, fallback];
  return patch;
}

// The base URL the local-backend manager actually talks to, normalized to a
// bare origin (protocol+host+port, `/v1` and trailing slashes stripped).
function managerOrigin(backend) {
  const base = backend === 'ollama' ? ollamaManager.getBaseUrl() : lmStudioManager.getBaseUrl();
  return normalizeOrigin(base);
}

// True when a hostname names the SAME local instance the backend manager runs
// on — any loopback (`127.0.0.0/8`, `::1`), `localhost`, or the unspecified /
// bind-all address (`0.0.0.0`, `::`, which a manager bound to all interfaces
// reports while a provider reaches it as localhost). These all canonicalize to
// one token so spelling differences don't block healing. Deliberately NOT
// link-local / LAN / Tailscale hosts — a peer on another box is a DIFFERENT
// instance whose installed models we must not heal against.
function isLocalInstanceHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function normalizeOrigin(url) {
  const cleaned = String(url || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  try {
    const u = new URL(cleaned);
    const host = isLocalInstanceHost(u.hostname) ? 'localhost' : u.hostname.toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${host}:${port}`;
  } catch { return ''; }
}

/**
 * True when the provider's configured endpoint points at the SAME instance the
 * backend manager enumerates models from. The heal lists installed models via
 * the singleton manager (bound to OLLAMA_URL / LM_STUDIO_URL), so if a provider
 * is pointed at a *different* host/port we'd otherwise pick + persist a model
 * installed on the wrong instance. When the origins disagree we decline to heal
 * (return false) rather than corrupt the config. A provider with no explicit
 * endpoint, or an unparseable URL on either side, is treated as a match —
 * best-effort, since the common local setup shares the default URL.
 */
function endpointMatchesManager(backend, provider) {
  const providerOrigin = normalizeOrigin(provider?.endpoint);
  if (!providerOrigin) return true; // no/unparseable endpoint — uses the local default the manager also targets
  const origin = managerOrigin(backend);
  return !origin || origin === providerOrigin;
}

// Installed models that can actually serve a chat completion, freshly listed
// (the configured model may have just been deleted, so bypass the cache).
async function listInstalledChatModels(backend) {
  if (backend === 'ollama') {
    const models = await ollamaManager.getInstalledModels(true).catch(() => []);
    // /api/tags doesn't tag embeddings — drop obvious embedding ids by name.
    return models.filter((m) => m?.id && !isEmbeddingModel(m.id));
  }
  const models = await lmStudioManager.getAvailableModels(true).catch(() => []);
  // LM Studio tags embedding models `type: 'embeddings'`.
  return models.filter((m) => m?.id && m.type !== 'embeddings');
}

/**
 * Repoint a local provider off a missing model onto a real installed one,
 * persist the change, and notify the user. Returns `{ healed, backend, model,
 * previous, patch }` on success, or null when nothing could be (or needed to
 * be) healed — not a local backend, the requested model is actually installed,
 * or nothing installable exists to fall back to.
 *
 * @param {{ provider: object, requestedModel?: string|null }} args
 */
export async function healMissingLocalModel({ provider, requestedModel }) {
  const backend = localBackendForProvider(provider);
  if (!backend) return null;

  // Only enumerate/repoint when the provider talks to the same instance the
  // manager lists from — otherwise we'd pick a model from the wrong backend.
  if (!endpointMatchesManager(backend, provider)) return null;

  const installed = await listInstalledChatModels(backend);
  if (!installed.length) return null; // nothing installed — can't self-heal

  const installedIds = installed.map((m) => m.id);
  if (requestedModel && installedIds.includes(requestedModel)) return null; // present after all

  const fallback = chooseFallbackModel(installed);
  if (!fallback || fallback === requestedModel) return null;

  // Persist the repoint so future runs use the real model. Track success: a
  // failed write must NOT be reported as "updated the provider default" (the
  // retry below still works for THIS run, but the bad config remains).
  const patch = computeProviderPatch(provider, installedIds, fallback, requestedModel);
  let persisted = false;
  if (provider?.id && Object.keys(patch).length) {
    // updateProvider resolves to the updated provider object, or null when the
    // id no longer exists — Boolean(updated) is the real persisted signal.
    persisted = await updateProvider(provider.id, patch)
      .then((updated) => Boolean(updated))
      .catch((err) => {
        console.error(`⚠️ Failed to repoint ${provider.id} to ${fallback}: ${err.message}`);
        return false;
      });
  }

  const label = backend === 'ollama' ? 'Ollama' : 'LM Studio';
  const had = requestedModel ? `"${requestedModel}" isn't installed` : 'no model was configured';
  const tail = persisted
    ? 'and updated the provider default.'
    : 'for this run (couldn\'t save the provider default — will retry the switch next time).';
  const message = `${label} model ${had} — switched to "${fallback}" ${tail}`;
  emitLog('warn', message, { providerId: provider?.id, backend, requestedModel: requestedModel || null, fallbackModel: fallback, persisted });
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: 'Local model auto-corrected',
    description: message,
    priority: PRIORITY_LEVELS.LOW,
    metadata: { providerId: provider?.id, backend, requestedModel: requestedModel || null, fallbackModel: fallback, persisted }
  }).catch((err) => console.error(`⚠️ heal notification failed: ${err.message}`));

  return { healed: true, backend, model: fallback, previous: requestedModel || null, patch, persisted };
}
