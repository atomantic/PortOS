/**
 * OpenCode configuration helpers.
 *
 * OpenCode (the CLI) requires every model addressable via `--model` to be
 * declared in its config. For a custom `@ai-sdk/openai-compatible` provider
 * (how we wire the local Ollama daemon and MTPLX), models live UNDER the
 * provider entry
 * as `provider.<id>.models.<bareModelId>` — there is no top-level `models` map
 * in OpenCode's schema, and the keys are the BARE model id (the part after the
 * `provider/` namespace), NOT the `ollama/`-prefixed form passed to `--model`.
 *
 * The shipped `OPENCODE_CONFIG_CONTENT` declared the Ollama provider but omitted
 * that models map, so OpenCode (>=1.17) rejected every `--model ollama/<id>` as
 * "Model ollama/… is not valid" — the pasted prompt sat in the input box and
 * the agent produced zero output (issue -2190). This module builds the config
 * dynamically at spawn time, declaring the provider's configured models (+ the
 * model being run) under
 * `provider.<local-backend>.models` with bare ids.
 */

import { getOpencodeLocalProviderNamespace, isOpencodeCommand } from './providerModels.js';

/**
 * Base OpenCode provider entries for the local OpenAI-compatible daemons.
 * The per-run models map is added under the selected entry by
 * `buildOpencodeConfig`.
 */
const OPENCODE_LOCAL_BASE_PROVIDERS = {
  ollama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Ollama (local)',
    options: { baseURL: 'http://localhost:11434/v1' },
  },
  mtplx: {
    npm: '@ai-sdk/openai-compatible',
    name: 'MTPLX (local MTP)',
    options: { baseURL: 'http://127.0.0.1:8000/v1' },
  },
  llama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'llama.cpp (local)',
    options: { baseURL: 'http://127.0.0.1:8080/v1' },
  },
  orcarouter: {
    npm: '@ai-sdk/openai-compatible',
    name: 'OrcaRouter',
    options: { baseURL: 'https://api.orcarouter.ai/v1' },
  },
};

const localProviderBase = (providerKey) => {
  if (!Object.hasOwn(OPENCODE_LOCAL_BASE_PROVIDERS, providerKey)) {
    throw new Error(`Unsupported OpenCode local provider '${providerKey}'`);
  }
  return OPENCODE_LOCAL_BASE_PROVIDERS[providerKey];
};

// Strip the selected provider namespace so a model id can key that provider's
// config `models` map. Idempotent for an already-bare id. A slash-bearing model
// id (`hf.co/user/model:tag`) retains every slash after the leading namespace.
const stripProviderPrefix = (id, providerKey) =>
  providerKey === 'orcarouter' ? id :
  typeof id === 'string' && id.startsWith(`${providerKey}/`)
    ? id.slice(providerKey.length + 1)
    : id;

/**
 * Normalize an id or list of ids to the unique, non-empty, prefix-stripped bare
 * model ids that key the OpenCode `models` map.
 * @param {string|string[]|null|undefined} models
 * @param {'ollama'|'mtplx'|'llama'|'orcarouter'} [providerKey='ollama']
 * @returns {string[]}
 */
export function toBareModelIds(models, providerKey = 'ollama') {
  localProviderBase(providerKey);
  const list = Array.isArray(models) ? models : [models];
  return [...new Set(
    list
      .filter((m) => typeof m === 'string' && m.length > 0)
      .map((id) => stripProviderPrefix(id, providerKey))
      .filter((m) => typeof m === 'string' && m.length > 0),
  )];
}

/**
 * Build an OpenCode config object declaring the given models under the selected
 * local provider. Accepts a single id or a list (bare or namespace-prefixed —
 * both are normalized to bare keys) and, optionally, a `base` config to merge
 * into (typically the provider's already-stored `OPENCODE_CONFIG_CONTENT`, parsed).
 *
 * The base is PRESERVED, not replaced: a custom `permission`, a custom local
 * `baseURL`, extra provider keys, and any hand-maintained models entries all
 * survive — this call only unions the given models into the selected provider.
 * When no usable id is provided the base is returned unchanged (no `models` key
 * is invented), identical to the shipped base. When `base` is absent/unusable,
 * the canonical endpoint for the selected local runtime is used.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into (a fresh clone is made)
 * @param {'ollama'|'mtplx'|'llama'|'orcarouter'} [providerKey='ollama']
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(models, base = null, providerKey = 'ollama', generation = null) {
  const bareIds = toBareModelIds(models, providerKey);
  const config = (base && typeof base === 'object')
    ? structuredClone(base)
    : { permission: 'allow', provider: {} };
  if (!config.provider || typeof config.provider !== 'object') config.provider = {};
  if (!config.provider[providerKey] || typeof config.provider[providerKey] !== 'object') {
    config.provider[providerKey] = structuredClone(localProviderBase(providerKey));
  }
  if (bareIds.length > 0) {
    const existing = (config.provider[providerKey].models && typeof config.provider[providerKey].models === 'object')
      ? config.provider[providerKey].models
      : {};
    config.provider[providerKey].models = {
      ...existing,
      ...Object.fromEntries(bareIds.map((id) => [id, { name: id, tool_call: true }])),
    };
  }
  // OpenCode applies generation controls to agents, not provider definitions.
  // `build` is its primary coding agent for both `opencode run` and the TUI;
  // unknown agent options are passed through to the provider, including
  // Ollama's native `think` flag.
  if (generation && providerKey === 'ollama') {
    const temperature = Number.isFinite(Number(generation.temperature)) ? Number(generation.temperature) : 0.6;
    // TASKS.md metadata is text, so a persisted task re-enters the lifecycle as
    // `'true'`/`'false'`. Accept both wire forms without treating an absent or
    // malformed value as an intentional override.
    const thinking = generation.thinking === true || generation.thinking === 'true'
      ? true
      : generation.thinking === false || generation.thinking === 'false'
        ? false
        : undefined;
    const effort = typeof generation.effort === 'string' && generation.effort.trim()
      ? generation.effort.trim()
      : undefined;
    config.agent = { ...(config.agent && typeof config.agent === 'object' ? config.agent : {}) };
    config.agent.build = {
      ...(config.agent.build && typeof config.agent.build === 'object' ? config.agent.build : {}),
      temperature,
      ...(thinking === undefined ? {} : { think: thinking }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
  }
  return config;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` env var value (JSON string) declaring the
 * given models under the selected local provider, merging into `base` when
 * provided.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into
 * @param {'ollama'|'mtplx'|'llama'|'orcarouter'} [providerKey='ollama']
 * @returns {string} JSON string for OPENCODE_CONFIG_CONTENT
 */
export function buildOpencodeConfigContent(models, base = null, providerKey = 'ollama', generation = null) {
  return JSON.stringify(buildOpencodeConfig(models, base, providerKey, generation));
}

/**
 * Build dynamic env vars for an OpenCode local-provider spawn. Returns an
 * object with `OPENCODE_CONFIG_CONTENT` (models map declared) for Ollama-,
 * MTPLX-, Llama-, or OrcaRouter-backed OpenCode providers, otherwise an empty object (caller keeps
 * existing env).
 *
 * The provider's already-stored `OPENCODE_CONFIG_CONTENT` is used as the base and
 * PRESERVED — a customized `baseURL`, `permission`, or hand-maintained models
 * survive; this only unions the runtime models into the selected provider. The
 * declared models are the union of the provider's configured models, its default
 * model, and the model being run this invocation — so whichever namespaced
 * `--model` the spawner passes is always accepted.
 *
 * @param {{command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, orcarouterBacked?:boolean, models?:string[], defaultModel?:string|null, apiKey?:string, orcarouterApiKey?:string, envVars?:object}} provider
 * @param {string|null|undefined} model - the model being run (may differ from defaultModel)
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} env vars to merge
 */
export function buildOpencodeEnvVars(provider, model) {
  const providerKey = getOpencodeLocalProviderNamespace(provider);
  if (!isOpencodeCommand(provider?.command) || !providerKey) {
    return {};
  }
  // Parse the provider's stored config as the base so any user customization
  // (custom baseURL, permission, hand-maintained models) is preserved rather
  // than clobbered by the hardcoded localhost default.
  const stored = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  let base = null;
  if (typeof stored === 'string' && stored.length > 0) {
    try {
      base = JSON.parse(stored);
    } catch {
      base = null; // unparseable stored config → fall back to the canonical default
    }
  }
  const ids = [
    ...(Array.isArray(provider?.models) ? provider.models : []),
    provider?.defaultModel,
    model,
  ];
  const config = buildOpencodeConfig(ids, base, providerKey, provider);
  const apiKey = providerKey === 'orcarouter' ? (provider?.apiKey || provider?.orcarouterApiKey) : null;
  if (apiKey) {
    config.provider.orcarouter.options = {
      ...config.provider.orcarouter.options,
      apiKey,
    };
  }
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(apiKey ? { ORCAROUTER_API_KEY: apiKey } : {}),
  };
}
