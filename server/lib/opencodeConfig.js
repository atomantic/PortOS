/**
 * OpenCode configuration helpers: builds the `OPENCODE_CONFIG_CONTENT` env for a provider and model.
 *
 * OpenCode requires every `--model` id to be declared in its config. For a custom
 * `@ai-sdk/openai-compatible` provider, models live UNDER the provider entry as
 * `provider.<id>.models.<bareModelId>` (no top-level `models` map; keys are the BARE
 * id, not the `ollama/`-prefixed `--model` form). Without the map, 1.18.x fails with
 * an opaque
 *
 *     {"name":"UnknownError","data":{"message":"Unexpected server error…"}}
 *
 * which reads like a broken provider. Two OTHER failures share the "spawns, ~12s, no
 * output" shape: `model '<id>' not found` (daemon lacks it; `services/provider/providerReadiness.js`
 * reports it) and `<id> does not support tools` (filtered by `_fetchOllamaToolCapableModels`).
 */

import {
  getOpencodeLocalProviderNamespace,
  isOpencodeCommand,
  prefixOpencodeModel,
  resolveCliEffort,
  parseOpencodeConfigContent,
  OPENCODE_BUILD_AGENT,
  OPENCODE_PUBLIC_REVIEW_AGENT,
} from './provider/providerModels.js';
import { PROVIDER_GATEWAYS, PROVIDER_GATEWAY_IDS, gatewayById, isGatewayNamespace } from './provider/providerGateways.js';
import { isPublicReviewNoToolProfile } from './agent/agentExecutionProfiles.js';
import { isPlainObject } from './objects.js';
import { PORTS } from './ports.js';

import { isTruthyMeta } from './metadataFlags.js';
const LLAMA_SERVER_BASE_URL = `http://127.0.0.1:${PORTS.LLAMA_SERVER}/v1`;
const VLLM_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.VLLM_QWEN}/v1`;
const SGLANG_QWEN_BASE_URL = `http://127.0.0.1:${PORTS.SGLANG_QWEN}/v1`;

/** Base provider entries for local OpenAI-compatible daemons; `buildOpencodeConfig` adds the per-run models map. */
const OPENCODE_LOCAL_BASE_PROVIDERS = {
  ollama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Ollama (local)',
    options: { baseURL: 'http://localhost:11434/v1' },
  },
  lmstudio: {
    npm: '@ai-sdk/openai-compatible',
    name: 'LM Studio (local)',
    // LM Studio's own app default, not a PortOS port (like Ollama's 11434).
    options: { baseURL: 'http://localhost:1234/v1' },
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
  // Hosted gateways share the OpenAI-compatible shape; rows are generated from the registry.
  ...Object.fromEntries(PROVIDER_GATEWAYS.map((gateway) => [gateway.id, {
    npm: '@ai-sdk/openai-compatible',
    name: gateway.label,
    options: { baseURL: gateway.baseURL },
  }])),
};

/**
 * The canonical base URL PortOS declares for one local OpenCode provider entry;
 * read by `lib/localProviderRuntime.js` so readiness and spawn agree.
 * @param {'ollama'|'lmstudio'|'mtplx'|'llama'|'vllm'|'sglang'|string} providerKey
 * @returns {string|null}
 */
export const opencodeLocalBaseUrl = (providerKey) =>
  OPENCODE_LOCAL_BASE_PROVIDERS[providerKey]?.options?.baseURL || null;

/** OpenCode local namespaces whose backend authenticates the request; keys are never attached to unauthenticated loopback daemons. */
const KEY_BEARING_NAMESPACES = new Set(['vllm', 'sglang', ...PROVIDER_GATEWAY_IDS]);

const localProviderBase = (providerKey) => {
  if (!Object.hasOwn(OPENCODE_LOCAL_BASE_PROVIDERS, providerKey)) {
    throw new Error(`Unsupported OpenCode local provider '${providerKey}'`);
  }
  return OPENCODE_LOCAL_BASE_PROVIDERS[providerKey];
};

// Strip the provider namespace so an id can key the `models` map (idempotent;
// slash-bearing ids like `hf.co/user/model:tag` keep later slashes). Gateway ids are
// already `vendor/model` and never prefixed in storage, so stripping would eat a real segment.
const stripProviderPrefix = (id, providerKey) =>
  isGatewayNamespace(providerKey) ? id :
  typeof id === 'string' && id.startsWith(`${providerKey}/`)
    ? id.slice(providerKey.length + 1)
    : id;

/**
 * Normalize ids to the unique, non-empty, prefix-stripped bare ids keying the `models` map.
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
 * `temperature`, `topP` and `reasoningEffort` are portable across the OpenAI
 * chat-completions shape. The toggle is NOT: Ollama takes a native `think` boolean;
 * llama.cpp / MTPLX / vLLM route it through the chat template
 * (`chat_template_kwargs.enable_thinking`); gateways get none (the editor hides the
 * checkbox). MIRROR of `generationControlsFor` in `client/src/utils/providerModels.js`.
 *
 * Every local runtime needs a row: `buildAgentGeneration` bails on a missing entry and
 * drops temperature / topP / reasoningEffort too (#4765); `opencodeConfig.test.js`
 * walks `LOCAL_RUNTIMES`.
 * @type {Record<string, 'think'|'chatTemplate'|null>}
 */
const THINKING_STYLE = {
  ollama: 'think',
  // LM Studio reasoning is a LOAD-TIME model property, not a documented per-request field; a toggle would pin a value nothing reads.
  lmstudio: null,
  mtplx: 'chatTemplate',
  llama: 'chatTemplate',
  vllm: 'chatTemplate',
  // SGLang serves Qwen3.8-27B with thinking ON by default; CoS coding wants it OFF
  // for reliable tool calls, so the control must exist, but nothing SEEDS `thinking: false` (#4716).
  sglang: 'chatTemplate',
  // Hosted gateways front cloud models that own their reasoning switch; no toggle.
  ...Object.fromEntries(PROVIDER_GATEWAY_IDS.map((id) => [id, null])),
};

const asObject = (value) => (isPlainObject(value) ? value : {});

/**
 * The OpenCode permissions that open an interactive gate: `question`, and
 * `plan_enter` / `plan_exit` (the plan agent's hand-back to a human). OpenCode denies
 * them in its own defaults because nothing can answer them without a person at the
 * terminal.
 *
 * A root `permission` is merged LAST and resolved with `findLast`, so the blanket
 * `permission: "allow"` PortOS writes would override that denial, and a denied
 * permission also hides its tool from the model: allowing it put `question` back
 * into a local model's schema and an unattended run parked on a question with nobody
 * to answer. Every PortOS OpenCode spawn is unattended, so these stay denied
 * unconditionally (an enforcement boundary); the rest of the blanket allow is kept so
 * agents don't stall on edit/bash approvals. UNATTENDED_RUN_RULE in
 * `services/agent/agentPromptBuilder.js` tells the agent not to ask; this makes asking unreachable.
 */
const INTERACTIVE_GATE_DENIALS = Object.freeze({
  question: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
});

/**
 * Re-apply {@link INTERACTIVE_GATE_DENIALS} over whatever root permission a config
 * carries (the string shorthand `"allow"` is expanded to `{'*': action}` first).
 *
 * **Key order is the enforcement.** OpenCode flattens the block in key order and
 * resolves with `findLast`, where a `'*'` KEY matches every permission, so denials
 * only bind AFTER the wildcard. Overwriting a gate key in place would keep its
 * original position (`{ question: 'deny', '*': 'allow' }` re-allows it), so gate keys
 * are DROPPED from the base and re-appended.
 *
 * Mutates and returns `config` (caller-owned).
 *
 * @param {object} config
 * @returns {object} the same config
 */
function denyInteractiveGates(config) {
  const current = config.permission;
  const base = typeof current === 'string' ? { '*': current } : asObject(current);
  const kept = Object.fromEntries(
    Object.entries(base).filter(([key]) => !Object.hasOwn(INTERACTIVE_GATE_DENIALS, key)),
  );
  config.permission = { ...kept, ...INTERACTIVE_GATE_DENIALS };
  return config;
}

const numberInRange = (value, min, max) => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

// Task metadata is text, so persisted tasks re-enter as `'true'`/`'false'`; accept both without treating absent/malformed as an override.
const readBoolean = (value) =>
  isTruthyMeta(value)
    ? true
    : value === false || value === 'false'
      ? false
      : undefined;

/**
 * The `agent.build` generation overrides for one local provider entry, or null when
 * nothing is configured. OpenCode applies generation controls to agents (`build` is
 * its primary coding agent), not provider definitions.
 *
 * @param {{temperature?:unknown, topP?:unknown, thinking?:unknown, effort?:unknown}|null|undefined} generation
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} providerKey
 * @returns {object|null}
 */
export function buildAgentGeneration(generation, providerKey) {
  if (!generation || !Object.hasOwn(THINKING_STYLE, providerKey)) return null;
  // Ollama agent runs default to 0.6; other backends keep their server-side default until set.
  const temperature = numberInRange(generation.temperature, 0, 2)
    ?? (providerKey === 'ollama' ? 0.6 : undefined);
  const topP = numberInRange(generation.topP, 0, 1);
  const thinking = readBoolean(generation.thinking);
  const thinkingStyle = THINKING_STYLE[providerKey];
  const effort = typeof generation.effort === 'string' && generation.effort.trim()
    ? generation.effort.trim()
    : undefined;
  // MTPLX reads a thinking level from the chat template, not from the OpenAI
  // `reasoning_effort` field OpenCode sends, so the level also rides in the template
  // kwargs, as the MTPLX API provider sends it (`aiToolkit/runner.js`). A template
  // without the variable ignores it.
  const templateKwargs = {
    ...(thinking === undefined || thinkingStyle !== 'chatTemplate' ? {} : { enable_thinking: thinking }),
    ...(effort === undefined || providerKey !== 'mtplx' ? {} : { reasoning_effort: effort }),
  };
  const build = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(thinking !== undefined && thinkingStyle === 'think' ? { think: thinking } : {}),
    ...(Object.keys(templateKwargs).length > 0 ? { chat_template_kwargs: templateKwargs } : {}),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
  return Object.keys(build).length > 0 ? build : null;
}

/**
 * Build an OpenCode config object declaring the given models (one id or a list, bare
 * or namespace-prefixed, normalized to bare keys) under the selected local provider,
 * optionally merging into a parsed `base` (typically the stored `OPENCODE_CONFIG_CONTENT`).
 *
 * The base is PRESERVED (custom `permission`, `baseURL`, extra provider keys,
 * hand-maintained models); this only unions the given models in. With no usable id
 * the base is returned unchanged; with no base, the runtime's canonical endpoint is
 * used. The one overwritten field is root `permission`: interactive-gate denials are
 * re-applied (see `denyInteractiveGates`).
 *
 * NOT the whole config: `buildOpencodeEnvVars` applies `small_model` downstream
 * because only it knows THIS run's single model.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into (a fresh clone is made)
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} [providerKey='ollama']
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(models, base = null, providerKey = 'ollama', generation = null) {
  // `null` = the harness's OWN catalog (OpenCode Zen): no provider entry or models
  // map to declare, so the provider half is skipped and the rest applies unchanged.
  const named = providerKey !== null && providerKey !== undefined;
  const bareIds = named ? toBareModelIds(models, providerKey) : [];
  const config = (base && typeof base === 'object')
    ? structuredClone(base)
    : { permission: 'allow', ...(named ? { provider: {} } : {}) };
  if (named) {
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
  }
  const build = buildAgentGeneration(generation, providerKey);
  if (build) {
    config.agent = { ...(config.agent && typeof config.agent === 'object' ? config.agent : {}) };
    config.agent.build = {
      ...(config.agent.build && typeof config.agent.build === 'object' ? config.agent.build : {}),
      ...build,
    };
  }
  return denyInteractiveGates(config);
}

// `'*'` is OpenCode's wildcard for a tool map; `deny` is a hard refusal (`ask` would
// hang a headless run). The ROOT uses the string shorthand because it denies EVERY
// category, including ones added later, and is the form shipped provider records
// already store; per-agent entries use the documented explicit object.
const DENY_ALL_TOOLS = Object.freeze({ '*': false });
const DENY_ALL_PERMISSIONS = 'deny';
const DENY_ALL_AGENT_PERMISSIONS = Object.freeze({ edit: 'deny', bash: 'deny', webfetch: 'deny' });

/**
 * Harden an OpenCode config for the `no-tool` public-review posture. OpenCode has no
 * argv equivalent of codex's `--sandbox read-only`, so its tool posture lives in
 * config and THIS is the enforced recipe (`providerVendors.js` pairs it with
 * `run --agent plan`). Four non-redundant controls:
 *
 *   1. root `permission` denies every category, covering unnamed agents;
 *   2. every agent gets the same denials plus an emptied tool map (per-agent settings
 *      OVERRIDE root, and the built-in `build`/`plan` carry their own tool maps);
 *   3. every declared model is `tool_call: false`, so no tool schema is advertised;
 *   4. MCP servers and plugins are cleared and sharing/autoupdate disabled, so
 *      nothing reaches the network on the side.
 *
 * Other stored config is PRESERVED. Mutates and returns `config` (caller-owned).
 *
 * @param {object} config
 * @returns {object} the same config, hardened
 */
function hardenOpencodeConfigForNoTool(config) {
  if (!isPlainObject(config)) return config;
  config.permission = DENY_ALL_PERMISSIONS;
  config.tools = { ...DENY_ALL_TOOLS };
  const agents = asObject(config.agent);
  const agentNames = new Set([...Object.keys(agents), OPENCODE_BUILD_AGENT, OPENCODE_PUBLIC_REVIEW_AGENT]);
  // `buildAgentGeneration` writes generation settings onto `agent.build`, but this
  // profile runs `--agent plan`: seed the review agent from `build` so the configured
  // effort reaches the model. An explicit `agent.plan` still wins (spread after).
  const generationSource = asObject(agents[OPENCODE_BUILD_AGENT]);
  config.agent = Object.fromEntries([...agentNames].map((name) => [name, {
    ...(name === OPENCODE_PUBLIC_REVIEW_AGENT ? generationSource : {}),
    ...asObject(agents[name]),
    tools: { ...DENY_ALL_TOOLS },
    permission: { ...DENY_ALL_AGENT_PERMISSIONS },
  }]));
  for (const entry of Object.values(asObject(config.provider))) {
    const models = asObject(entry?.models);
    for (const [id, model] of Object.entries(models)) {
      models[id] = { ...asObject(model), tool_call: false };
    }
  }
  config.mcp = {};
  config.plugin = [];
  config.share = 'disabled';
  config.autoupdate = false;
  return config;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` JSON string; see `buildOpencodeConfig`.
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
 * The provider record as a GENERATION source for THIS run's model, with a stored
 * effort the model rejects clamped to the nearest accepted rung (`resolveCliEffort`).
 * OpenCode forwards `reasoningEffort` verbatim and only the upstream validates it
 * (NIM answers Kimi K3 `thinking_effort="medium"` with HTTP 400, wedging the launch);
 * the provider-wide ladder can't see the model.
 *
 * Returns the input untouched when there is nothing to clamp, so a record with no
 * effort (and its non-enumerable gateway `apiKey`) rides through unspread.
 * @param {object|null|undefined} provider
 * @param {string|null|undefined} model - the model this spawn runs
 * @returns {object|null|undefined}
 */
function generationForModel(provider, model) {
  const stored = typeof provider?.effort === 'string' ? provider.effort.trim() : '';
  if (!stored) return provider;
  const resolved = resolveCliEffort(stored, provider, model || provider?.defaultModel || null);
  return resolved === stored ? provider : { ...provider, effort: resolved || null };
}

/**
 * Build dynamic env vars for an OpenCode spawn: `OPENCODE_CONFIG_CONTENT` for a
 * provider naming a backend namespace (Ollama, MTPLX, llama.cpp, vLLM, SGLang, or a
 * hosted gateway) and for a NAMESPACE-LESS record with a stored config (the seeded Zen
 * wrappers: base plus the `small_model` pin, no provider entry or key). Otherwise an
 * empty object.
 *
 * The stored `OPENCODE_CONFIG_CONTENT` is the PRESERVED base; declared models are the
 * union of configured models, default model and the model being run, so the
 * spawner's `--model` is always accepted.
 *
 * @param {{command?:string, ollamaBacked?:boolean, lmstudioBacked?:boolean, mtplxBacked?:boolean, llamaBacked?:boolean, vllmBacked?:boolean, sglangBacked?:boolean, gatewayBacked?:string, orcarouterBacked?:boolean, models?:string[], defaultModel?:string|null, apiKey?:string, orcarouterApiKey?:string, envVars?:object}} provider
 * @param {string|null|undefined} model - the model being run (may differ from defaultModel)
 * @param {{safetyProfile?:string|null}} [options] - `no-tool` public-review applies `hardenOpencodeConfigForNoTool`.
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} env vars to merge
 */
export function buildOpencodeEnvVars(provider, model, { safetyProfile = null } = {}) {
  const providerKey = getOpencodeLocalProviderNamespace(provider);
  if (!isOpencodeCommand(provider?.command)) {
    return {};
  }
  // Parse the stored config as the base so user customization is preserved.
  const base = parseOpencodeConfigContent(provider?.envVars?.OPENCODE_CONFIG_CONTENT);
  // A NAMESPACE-LESS record with no stored config is a hand-made plain `opencode`
  // provider running against the user's `~/.config/opencode`; `OPENCODE_CONFIG_CONTENT`
  // REPLACES that file wholesale, so synthesizing one would drop their providers.
  // Seeded Zen records ship `{"permission":"allow"}` and take the path below.
  if (!providerKey && !base) return {};

  const ids = [
    ...(Array.isArray(provider?.models) ? provider.models : []),
    provider?.defaultModel,
    model,
  ];
  const config = buildOpencodeConfig(ids, base, providerKey, generationForModel(provider, model));
  // Pin the auxiliary model for OpenCode's OWN side work (titles, summarization):
  // unset, it falls back to a built-in hosted model nobody chose (paid calls, or a
  // cloud provider via an inherited API key), which the AI Provider Usage Policy
  // forbids. Unconditional: a run stays on the model it was dispatched with, which is
  // always in the declared models map. A stored `small_model` wins.
  if (!config.small_model && model) {
    config.small_model = prefixOpencodeModel(provider, model);
  }
  // Key-bearing namespaces read `provider.apiKey` (a gateway's `legacyApiKeyField` is an
  // older alias); vLLM's stack is started with `VLLM_API_KEY`, so loopback still 401s
  // without it. Keyed off the RESOLVED namespace: a record with both a local and a
  // gateway marker resolves local and must not export a gateway key. A null
  // namespace has no provider entry to attach a key to.
  const gateway = providerKey ? gatewayById(providerKey) : null;
  const apiKey = providerKey && KEY_BEARING_NAMESPACES.has(providerKey)
    ? (provider?.apiKey || (gateway?.legacyApiKeyField ? provider?.[gateway.legacyApiKeyField] : null))
    : null;
  if (apiKey && providerKey) {
    config.provider[providerKey].options = {
      ...config.provider[providerKey].options,
      apiKey,
    };
  }
  // LAST: overrides everything above, including a stored `permission: "allow"` and
  // `tool_call: true`. The enforcement boundary.
  if (isPublicReviewNoToolProfile(safetyProfile)) hardenOpencodeConfigForNoTool(config);
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(apiKey && gateway ? { [gateway.apiKeyEnv]: apiKey } : {}),
  };
}
