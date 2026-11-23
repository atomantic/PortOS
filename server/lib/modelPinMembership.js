/**
 * Which LOCAL daemon backs a provider, and whether a stored model pin is one
 * that provider may still be handed.
 */

import { localRuntimeNamespace, isAntigravityProvider, isOpencodeProvider, antigravityCatalogListsModel, filterSelectableModels } from './provider/providerModels.js';
import { PORTS } from './ports.js';
import { localEndpointPort } from './localEndpoint.js';

/**
 * Which PortOS page manages each local runtime (source for `LOCAL_RUNTIMES[*].manageUrl`); in this leaf
 * because the client cannot import the endpoint half. `null` = no PortOS page (operator-owned compose).
 */
export const LOCAL_RUNTIME_MANAGE_URLS = Object.freeze({
  llama: '/models/llms-runtimes',
  ollama: '/models/llms',
  lmstudio: '/models/llms',
  vllm: null,
  sglang: null,
  slotstream: '/models/llms-runtimes',
  mtplx: '/models/llms-runtimes',
});

// Default ports of the two local backends; an endpoint-only provider aimed at one on this instance maps to it.
const BACKEND_DEFAULT_PORT = { 11434: 'ollama', 1234: 'lmstudio' };

// Name/id/default-port shape only. Locality is the caller's concern: `ollamaManager.isOllamaProvider` layers
// an `isLocalInstanceEndpoint` check on top of `localRuntimeKind`, which this module must not import back.
const isOllamaShape = (provider) =>
  provider?.id === 'ollama' ||
  /ollama/i.test(provider?.name || '') ||
  /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(String(provider?.endpoint || ''));

/**
 * Local backend a provider maps to: id/name, else an endpoint on its default port on this machine.
 * @returns {'ollama'|'lmstudio'|null}
 */
export function localBackendForProvider(provider) {
  if (isOllamaShape(provider)) return 'ollama';
  if (provider?.id === 'lmstudio' || /lm[\s-]?studio/i.test(provider?.name || '')) return 'lmstudio';
  const port = localEndpointPort(provider?.endpoint);
  return port ? (BACKEND_DEFAULT_PORT[port] || null) : null;
}

/**
 * Local-runtime kind: authoritative `*Backed` markers first, endpoint/name as fallback. Hosted gateways
 * (`providerGateways.js`) are excluded: remote APIs with no local daemon.
 * @param {object|null|undefined} provider
 * @returns {'llama'|'ollama'|'lmstudio'|'mtplx'|'vllm'|'sglang'|'slotstream'|null}
 */
export function localRuntimeKind(provider) {
  if (!provider || typeof provider !== 'object') return null;
  // Marker-based, not command-based: also resolves `claude-ollama` (`ollamaBacked`, not OpenCode).
  const namespace = localRuntimeNamespace(provider);
  if (namespace) return namespace;
  if (provider?.id === 'slotstream' || /slotstream/i.test(provider?.name || '')) return 'slotstream';
  if (Number(localEndpointPort(provider?.endpoint)) === PORTS.SLOTSTREAM) return 'slotstream';
  // The shipped `mtplx` record carries no marker (`mtplxBacked` only rides the CLI wrappers); `id` is its
  // one signal. No port arm: MTPLX's port is user-configurable with a generic default (`:8000`), unlike
  // slotstream's PortOS-dedicated one. `isMtplxProvider` in `mtplxServerManager.js` adds a live-port check.
  if (provider?.id === 'mtplx') return 'mtplx';
  return localBackendForProvider(provider);
}

/** `namespace/model` → bare id, splitting on the FIRST slash only, as OpenCode does. */
const bareOpencodeModel = (value) => value.slice(value.indexOf('/') + 1);

/**
 * Whether a provider may be handed `model` — the ONE rule for validating a stored pin.
 *
 * Pass-through: a provider enumerating NO models, or backed by a LOCAL daemon (incl. `mtplx`), whose
 * `models` array is a stale snapshot while the daemon is the authority. Otherwise exact, with two
 * same-model tolerances (#7327): agy compares on BASE ids (the tier rides on `--effort`), and OpenCode
 * pins are bare while the catalog may be `namespace/model`. A configured-default sentinel is NOT a
 * pass-through (see `providerCatalogListsModel`).
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function modelPinIsOffered(provider, model) {
  const offered = Array.isArray(provider?.models) ? provider.models : [];
  if (offered.length === 0 || localRuntimeKind(provider)) return true;
  if (offered.includes(model)) return true;
  if (typeof model !== 'string' || model.trim() === '') return false;

  const id = model.trim();
  // Sentinels are never what a pin matches; an empty base list reads as "no catalog" (pass-through).
  const ids = filterSelectableModels(offered.filter((m) => typeof m === 'string'));
  if (isAntigravityProvider(provider)) return antigravityCatalogListsModel(id, ids);
  // Gated on OpenCode: ungated, `custom/gpt-4o` would match an OpenAI record listing `gpt-4o` and be
  // handed to a CLI/API that rejects it.
  if (!isOpencodeProvider(provider)) return false;
  return ids.some((listed) => bareOpencodeModel(listed) === bareOpencodeModel(id));
}
