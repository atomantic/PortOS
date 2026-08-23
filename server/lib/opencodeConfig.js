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
import { PROVIDER_GATEWAYS, PROVIDER_GATEWAY_IDS, gatewayById, isGatewayNamespace } from './providerGateways.js';
import { PORTS } from './ports.js';

const LLAMA_SERVER_BASE_URL = `http://127.0.0.1:${PORTS.LLAMA_SERVER}/v1`;
const VLLM_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.VLLM_QWEN}/v1`;
const SGLANG_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.SGLANG_QWEN}/v1`;

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
    options: { baseURL: LLAMA_SERVER_BASE_URL },
  },
  vllm: {
    npm: '@ai-sdk/openai-compatible',
    name: 'vLLM Qwen3.8-27B (local)',
    options: { baseURL: VLLM_QWEN_BASE_URL },
  },
  sglang: {
    npm: '@ai-sdk/openai-compatible',
    name: 'SGLang Qwen3.8-27B (local)',
    options: { baseURL: SGLANG_QWEN_BASE_URL },
  },
  // Every hosted gateway (`providerGateways.js`) declares the same
  // OpenAI-compatible shape, so the rows are generated rather than hand-listed —
  // a new gateway is one registry row, not an edit here.
  ...Object.fromEntries(PROVIDER_GATEWAYS.map((gateway) => [gateway.id, {
    npm: '@ai-sdk/openai-compatible',
    name: gateway.label,
    options: { baseURL: gateway.baseURL },
  }])),
};

/**
 * The canonical base URL PortOS declares for one local OpenCode provider entry
 * — what a spawned OpenCode talks to when the provider stores no config of its
 * own. Read by `lib/localProviderRuntime.js` so the readiness probe and the
 * spawn agree on the endpoint instead of keeping two copies of these ports.
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} providerKey
 * @returns {string|null}
 */
export const opencodeLocalBaseUrl = (providerKey) =>
  OPENCODE_LOCAL_BASE_PROVIDERS[providerKey]?.options?.baseURL || null;

/**
 * OpenCode local namespaces whose backend authenticates the request. Everything
 * else here is an unauthenticated loopback daemon, and attaching a key to those
 * would put a secret into a config file that never needed one.
 */
const KEY_BEARING_NAMESPACES = new Set(['vllm', 'sglang', ...PROVIDER_GATEWAY_IDS]);

const localProviderBase = (providerKey) => {
  if (!Object.hasOwn(OPENCODE_LOCAL_BASE_PROVIDERS, providerKey)) {
    throw new Error(`Unsupported OpenCode local provider '${providerKey}'`);
  }
  return OPENCODE_LOCAL_BASE_PROVIDERS[providerKey];
};

// Strip the selected provider namespace so a model id can key that provider's
// config `models` map. Idempotent for an already-bare id. A slash-bearing model
// id (`hf.co/user/model:tag`) retains every slash after the leading namespace.
// A hosted gateway's model ids are already `vendor/model` and are NEVER
// namespace-prefixed in storage, so stripping would eat a real id segment
// (`anthropic/claude-sonnet-4` is the key, not `claude-sonnet-4`).
const stripProviderPrefix = (id, providerKey) =>
  isGatewayNamespace(providerKey) ? id :
  typeof id === 'string' && id.startsWith(`${providerKey}/`)
    ? id.slice(providerKey.length + 1)
    : id;

/**
 * Normalize an id or list of ids to the unique, non-empty, prefix-stripped bare
 * model ids that key the OpenCode `models` map.
 * @param {string|string[]|null|undefined} models
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} [providerKey='ollama']
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
 * How each local OpenCode provider entry carries a "thinking" toggle.
 *
 * `temperature`, `topP` and `reasoningEffort` are portable — every daemon behind
 * these entries speaks the OpenAI chat-completions shape, so they are emitted
 * for all of them. The thinking toggle is NOT: Ollama takes its own native
 * `think` boolean, while a llama.cpp / MTPLX / vLLM OpenAI endpoint routes it
 * through the chat template (`chat_template_kwargs.enable_thinking`). A hosted
 * gateway fronts cloud models that own their reasoning switch upstream, so it
 * gets no toggle at all and the editor hides the checkbox for it. MIRROR of
 * `generationControlsFor` in `client/src/utils/providers.js`; keep in lockstep.
 *
 * A missing entry is not a missing checkbox — `buildAgentGeneration` bails on it
 * and drops temperature / topP / reasoningEffort along with the toggle, which is
 * how vLLM shipped with no generation controls at all (#4765). Every local
 * runtime OpenCode can be pointed at needs a row here; `opencodeConfig.test.js`
 * walks `LOCAL_RUNTIMES` to make a missing one fail.
 * @type {Record<string, 'think'|'chatTemplate'|null>}
 */
const THINKING_STYLE = {
  ollama: 'think',
  mtplx: 'chatTemplate',
  llama: 'chatTemplate',
  // vLLM routes it through the chat template exactly as MTPLX and llama.cpp do
  // — see `server/services/voice/llm.js` for the same body shape on the HTTP side.
  vllm: 'chatTemplate',
  // SGLang serves Qwen3.8-27B with thinking ON by default, disabled per request
  // through the same `chat_template_kwargs.enable_thinking` the other local
  // OpenAI endpoints take. CoS coding wants it OFF (that is what keeps the
  // tool-call format reliable), so the control has to exist for the operator to
  // set — but nothing here SEEDS `thinking: false`, per #4716.
  sglang: 'chatTemplate',
  // Every hosted gateway fronts cloud models that own their reasoning switch
  // upstream, so none of them gets a toggle — the editor hides the checkbox for
  // them (`generationControlsFor` in client/src/utils/providers.js).
  ...Object.fromEntries(PROVIDER_GATEWAY_IDS.map((id) => [id, null])),
};

const numberInRange = (value, min, max) => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

// TASKS.md metadata is text, so a persisted task re-enters the lifecycle as
// `'true'`/`'false'`. Accept both wire forms without treating an absent or
// malformed value as an intentional override.
const readBoolean = (value) =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : undefined;

/**
 * The `agent.build` generation overrides for one local OpenCode provider entry,
 * or null when nothing is configured. OpenCode applies generation controls to
 * agents, not provider definitions; `build` is its primary coding agent for both
 * `opencode run` and the TUI, and unknown agent options are passed through to
 * the provider.
 *
 * @param {{temperature?:unknown, topP?:unknown, thinking?:unknown, effort?:unknown}|null|undefined} generation
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} providerKey
 * @returns {object|null}
 */
export function buildAgentGeneration(generation, providerKey) {
  if (!generation || !Object.hasOwn(THINKING_STYLE, providerKey)) return null;
  // Ollama agent runs have defaulted to 0.6 since this control shipped. The
  // other backends keep their own server-side default until the user sets one,
  // so opening the editor up to them changes nothing on its own.
  const temperature = numberInRange(generation.temperature, 0, 2)
    ?? (providerKey === 'ollama' ? 0.6 : undefined);
  const topP = numberInRange(generation.topP, 0, 1);
  const thinking = readBoolean(generation.thinking);
  const thinkingStyle = THINKING_STYLE[providerKey];
  const effort = typeof generation.effort === 'string' && generation.effort.trim()
    ? generation.effort.trim()
    : undefined;
  const build = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(thinking === undefined || thinkingStyle === null
      ? {}
      : thinkingStyle === 'think'
        ? { think: thinking }
        : { chat_template_kwargs: { enable_thinking: thinking } }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
  return Object.keys(build).length > 0 ? build : null;
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
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} [providerKey='ollama']
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
  const build = buildAgentGeneration(generation, providerKey);
  if (build) {
    config.agent = { ...(config.agent && typeof config.agent === 'object' ? config.agent : {}) };
    config.agent.build = {
      ...(config.agent.build && typeof config.agent.build === 'object' ? config.agent.build : {}),
      ...build,
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
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} [providerKey='ollama']
 * @returns {string} JSON string for OPENCODE_CONFIG_CONTENT
 */
export function buildOpencodeConfigContent(models, base = null, providerKey = 'ollama', generation = null) {
  return JSON.stringify(buildOpencodeConfig(models, base, providerKey, generation));
}

/**
 * Build dynamic env vars for an OpenCode local-provider spawn. Returns an
 * object with `OPENCODE_CONFIG_CONTENT` (models map declared) for Ollama-,
 * MTPLX-, Llama-, vLLM-, or OrcaRouter-backed OpenCode providers, otherwise an empty object (caller keeps
 * existing env).
 *
 * The provider's already-stored `OPENCODE_CONFIG_CONTENT` is used as the base and
 * PRESERVED — a customized `baseURL`, `permission`, or hand-maintained models
 * survive; this only unions the runtime models into the selected provider. The
 * declared models are the union of the provider's configured models, its default
 * model, and the model being run this invocation — so whichever namespaced
 * `--model` the spawner passes is always accepted.
 *
 * @param {{command?:string, ollamaBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean, models?:string[], defaultModel?:string|null, apiKey?:string, orcarouterApiKey?:string, envVars?:object}} provider
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
  // Every key-bearing namespace reads the SAME `provider.apiKey` field; a
  // gateway's `legacyApiKeyField` (`orcarouterApiKey`) is an older alias kept
  // readable forever. vLLM's compose stack is started with `VLLM_API_KEY`, so a
  // wrapper pointed at it needs the key on `options.apiKey` exactly the way a
  // hosted gateway does — the endpoint is loopback, but the server still 401s
  // without it.
  // Keyed off the RESOLVED namespace, not the record's marker: a malformed
  // record carrying both a local marker and a gateway marker resolves to the
  // local namespace above, and must not then export a gateway key env var.
  const gateway = gatewayById(providerKey);
  const apiKey = KEY_BEARING_NAMESPACES.has(providerKey)
    ? (provider?.apiKey || (gateway?.legacyApiKeyField ? provider?.[gateway.legacyApiKeyField] : null))
    : null;
  if (apiKey) {
    config.provider[providerKey].options = {
      ...config.provider[providerKey].options,
      apiKey,
    };
  }
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(apiKey && gateway ? { [gateway.apiKeyEnv]: apiKey } : {}),
  };
}
