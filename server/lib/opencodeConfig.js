/**
 * OpenCode configuration helpers.
 *
 * OpenCode (the CLI) requires every model addressable via `--model` to be
 * declared in its config. For a custom `@ai-sdk/openai-compatible` provider
 * (how we wire the local Ollama daemon), models live UNDER the provider entry
 * as `provider.<id>.models.<bareModelId>` — there is no top-level `models` map
 * in OpenCode's schema, and the keys are the BARE model id (the part after the
 * `provider/` namespace), NOT the `ollama/`-prefixed form passed to `--model`.
 *
 * The shipped `OPENCODE_CONFIG_CONTENT` declared the Ollama provider but omitted
 * that models map, so OpenCode (>=1.17) rejected every `--model ollama/<id>` as
 * "Model ollama/… is not valid" — the pasted prompt sat in the input box, the
 * agent produced zero output, and the idle reaper marked it complete (issue
 * -2190). This module builds the config dynamically at spawn time, declaring the
 * provider's configured models (+ the model being run) under
 * `provider.ollama.models` with bare ids.
 */

import { isOpencodeCommand } from './providerModels.js';

/**
 * Base OpenCode provider entry for the local Ollama daemon (openai-compatible).
 * The per-run models map is added under this by `buildOpencodeConfig`.
 */
const OPENCODE_OLLAMA_BASE_PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'Ollama (local)',
  options: { baseURL: 'http://localhost:11434/v1' },
};

// Strip a leading `ollama/` namespace so a model id can key the config `models`
// map (which lives under the `ollama` provider — keys are bare ids). Idempotent
// for an already-bare id. A `/`-bearing Ollama id (`hf.co/user/model:tag`)
// namespaced as `ollama/hf.co/...` strips back to the correct bare key since
// only the leading namespace is removed.
const stripOllamaPrefix = (id) =>
  typeof id === 'string' && id.startsWith('ollama/') ? id.slice('ollama/'.length) : id;

/**
 * Normalize an id or list of ids to the unique, non-empty, prefix-stripped bare
 * model ids that key the OpenCode `models` map.
 * @param {string|string[]|null|undefined} models
 * @returns {string[]}
 */
export function toBareModelIds(models) {
  const list = Array.isArray(models) ? models : [models];
  return [...new Set(
    list
      .filter((m) => typeof m === 'string' && m.length > 0)
      .map(stripOllamaPrefix)
      .filter((m) => typeof m === 'string' && m.length > 0),
  )];
}

/**
 * Build an OpenCode config object declaring the given models under the Ollama
 * provider. Accepts a single id or a list (bare or `ollama/`-prefixed — both are
 * normalized to bare keys) and, optionally, a `base` config to merge into
 * (typically the provider's already-stored `OPENCODE_CONFIG_CONTENT`, parsed).
 *
 * The base is PRESERVED, not replaced: a custom `permission`, a custom Ollama
 * `baseURL`, extra provider keys, and any hand-maintained
 * `provider.ollama.models` entries all survive — this call only unions the given
 * models into `provider.ollama.models`. When no usable id is provided the base
 * is returned unchanged (no `models` key is invented), identical to the shipped
 * base — no regression. When `base` is absent/unusable, the canonical
 * localhost-Ollama default is used.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into (a fresh clone is made)
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(models, base = null) {
  const bareIds = toBareModelIds(models);
  const config = (base && typeof base === 'object')
    ? structuredClone(base)
    : { permission: 'allow', provider: {} };
  if (!config.provider || typeof config.provider !== 'object') config.provider = {};
  if (!config.provider.ollama || typeof config.provider.ollama !== 'object') {
    config.provider.ollama = { ...OPENCODE_OLLAMA_BASE_PROVIDER };
  }
  if (bareIds.length > 0) {
    const existing = (config.provider.ollama.models && typeof config.provider.ollama.models === 'object')
      ? config.provider.ollama.models
      : {};
    config.provider.ollama.models = {
      ...existing,
      ...Object.fromEntries(bareIds.map((id) => [id, { name: id, tool_call: true }])),
    };
  }
  return config;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` env var value (JSON string) declaring the
 * given models under the Ollama provider, merging into `base` when provided.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into
 * @returns {string} JSON string for OPENCODE_CONFIG_CONTENT
 */
export function buildOpencodeConfigContent(models, base = null) {
  return JSON.stringify(buildOpencodeConfig(models, base));
}

/**
 * Build dynamic env vars for an OpenCode Ollama provider spawn. Returns an
 * object with `OPENCODE_CONFIG_CONTENT` (models map declared) for Ollama-backed
 * OpenCode providers, otherwise an empty object (caller keeps existing env).
 *
 * The provider's already-stored `OPENCODE_CONFIG_CONTENT` is used as the base and
 * PRESERVED — a customized `baseURL`, `permission`, or hand-maintained models
 * survive; this only unions the runtime models into `provider.ollama.models`. The
 * declared models are the union of the provider's configured models, its default
 * model, and the model being run this invocation — so whichever
 * `--model ollama/<id>` the spawner passes is always accepted.
 *
 * @param {{command?:string, ollamaBacked?:boolean, models?:string[], defaultModel?:string|null, envVars?:object}} provider
 * @param {string|null|undefined} model - the model being run (may differ from defaultModel)
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} env vars to merge
 */
export function buildOpencodeEnvVars(provider, model) {
  if (!isOpencodeCommand(provider?.command) || provider?.ollamaBacked !== true) {
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
  return {
    OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(ids, base),
  };
}
