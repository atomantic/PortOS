/**
 * Default generation controls, rendered into an OpenAI `/chat/completions` body.
 *
 * Same provider-level defaults the OpenCode wrappers render
 * (`server/lib/opencodeConfig.js` `buildAgentGeneration`). Scoped to LOCAL
 * OpenAI-compatible backends on purpose: a cloud provider's body carries no
 * sampling fields unless the user pins them.
 *
 * Also owns OpenRouter's `provider` routing preferences (`providerRouting`): the
 * resolver that renders the body's `provider` object (its zod schema is
 * `providerRoutingSchema` in `validation.js`; this file stays browser-safe, so no
 * zod). The result is `undefined` for every non-OpenRouter endpoint so a local daemon
 * or direct vendor API gets a byte-identical payload. Kept here, not in a new
 * file, to hold the boot import-closure ceiling.
 *
 * Lives beside `ollamaBacked.js` so `runner.js` avoids a cycle through `providers.js`.
 */
import { isOllamaBackedProvider } from './ollamaBacked.js';

const finiteNumber = (value, min, max) => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

/**
 * Every local backend marker belongs in the guard below: a missing one returns
 * `{}` and drops temperature and top_p too.
 *
 * @param {{temperature?:unknown, topP?:unknown, thinking?:unknown, lmstudioBacked?:boolean, llamaBacked?:boolean, mtplxBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean}|null|undefined} provider
 * @returns {{temperature?:number, top_p?:number, think?:boolean, chat_template_kwargs?:{enable_thinking:boolean}}}
 */
export function apiGenerationOptions(provider) {
  const ollama = isOllamaBackedProvider(provider);
  const lmstudio = provider?.lmstudioBacked === true;
  if (!ollama
    && !lmstudio
    && provider?.llamaBacked !== true
    && provider?.mtplxBacked !== true
    && provider?.vllmBacked !== true
    && provider?.sglangBacked !== true) return {};
  // Only Ollama defaults to 0.6; other backends keep their own until pinned.
  const temperature = finiteNumber(provider.temperature, 0, 2) ?? (ollama ? 0.6 : undefined);
  const topP = finiteNumber(provider.topP, 0, 1);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    // Ollama takes a native `think` boolean; llama.cpp / MTPLX / vLLM / SGLang
    // use the chat template. LM Studio takes neither (reasoning is a property of
    // the loaded model instance).
    ...(typeof provider.thinking !== 'boolean' || lmstudio
      ? {}
      : ollama
        ? { think: provider.thinking }
        : { chat_template_kwargs: { enable_thinking: provider.thinking } }),
  };
}

// ---- OpenRouter provider routing ----

const FLAT_KEYS = ['sort', 'only', 'ignore', 'order', 'require_parameters', 'data_collection'];
const OPENROUTER_HOSTS = new Set(['openrouter.ai', 'api.openrouter.ai']);

/** Both `foo` and `openrouter/foo` name the same model. */
const stripPrefix = (model) => String(model || '').replace(/^openrouter\//i, '');

/** True for an OpenRouter service instance or any endpoint on openrouter.ai. */
export function isOpenRouterProvider(provider) {
  if (!provider) return false;
  if (provider.serviceDefinitionId === 'openrouter') return true;
  try {
    return OPENROUTER_HOSTS.has(new URL(String(provider.endpoint || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Drop unset keys: null/undefined/empty lists/false never reach the wire. */
function compact(flat) {
  const out = {};
  if (flat.sort) out.sort = flat.sort;
  if (flat.data_collection) out.data_collection = flat.data_collection;
  if (flat.require_parameters === true) out.require_parameters = true;
  for (const key of ['only', 'ignore', 'order']) {
    if (Array.isArray(flat[key]) && flat[key].length) out[key] = [...flat[key]];
  }
  return out;
}

/**
 * The top-level `provider` body object for this endpoint/model, or `undefined`
 * when the endpoint is not OpenRouter or nothing is configured. A key present in
 * the matching per-model override replaces the flat default (an explicit
 * `only: []` therefore clears an inherited pin for that model).
 *
 * @param {object|null|undefined} provider record carrying `providerRouting` and `endpoint`
 * @param {string} [model]
 * @returns {object|undefined}
 */
export function resolveOpenRouterProviderField(provider, model) {
  const routing = provider?.providerRouting;
  if (!routing || typeof routing !== 'object' || !isOpenRouterProvider(provider)) return undefined;
  const wanted = stripPrefix(model).toLowerCase();
  const overrideKey = wanted
    ? Object.keys(routing.models || {}).find((key) => stripPrefix(key).toLowerCase() === wanted)
    : undefined;
  const merged = { ...pickFlat(routing), ...(overrideKey ? pickFlat(routing.models[overrideKey]) : {}) };
  const resolved = compact(merged);
  return Object.keys(resolved).length ? resolved : undefined;
}

/** Own keys whose value is not `undefined`, so an override only replaces what it names. */
function pickFlat(source) {
  const out = {};
  for (const key of FLAT_KEYS) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
}

/** `{ provider }` to spread into a request body, or `{}`. */
export function openRouterBodyFragment(provider, model) {
  const field = resolveOpenRouterProviderField(provider, model);
  return field ? { provider: field } : {};
}
