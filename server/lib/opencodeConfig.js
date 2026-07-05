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
 * normalized to bare keys). Returns the base config with no `models` key when no
 * usable id is provided (identical to the shipped base — no regression).
 *
 * @param {string|string[]|null|undefined} models
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(models) {
  const bareIds = toBareModelIds(models);
  const ollama = { ...OPENCODE_OLLAMA_BASE_PROVIDER };
  if (bareIds.length > 0) {
    ollama.models = Object.fromEntries(
      bareIds.map((id) => [id, { name: id, tool_call: true }]),
    );
  }
  return { permission: 'allow', provider: { ollama } };
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` env var value (JSON string) declaring the
 * given models under the Ollama provider.
 *
 * @param {string|string[]|null|undefined} models
 * @returns {string} JSON string for OPENCODE_CONFIG_CONTENT
 */
export function buildOpencodeConfigContent(models) {
  return JSON.stringify(buildOpencodeConfig(models));
}

/**
 * Build dynamic env vars for an OpenCode Ollama provider spawn. Returns an
 * object with `OPENCODE_CONFIG_CONTENT` (models map declared) for Ollama-backed
 * OpenCode providers, otherwise an empty object (caller keeps existing env).
 *
 * The declared models are the union of the provider's configured models, its
 * default model, and the model being run this invocation — so whichever
 * `--model ollama/<id>` the spawner passes is always accepted.
 *
 * @param {{command?:string, ollamaBacked?:boolean, models?:string[], defaultModel?:string|null}} provider
 * @param {string|null|undefined} model - the model being run (may differ from defaultModel)
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} env vars to merge
 */
export function buildOpencodeEnvVars(provider, model) {
  if (!isOpencodeCommand(provider?.command) || provider?.ollamaBacked !== true) {
    return {};
  }
  const ids = [
    ...(Array.isArray(provider?.models) ? provider.models : []),
    provider?.defaultModel,
    model,
  ];
  return {
    OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(ids),
  };
}
