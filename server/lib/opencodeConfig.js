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
 *
 * **The custom-provider shape above is still the supported one** — re-verified
 * against OpenCode 1.18.27, where a config carrying the models map round-trips a
 * local Ollama model fine. What CHANGED is the diagnostic: the same undeclared
 * model that used to say "Model ollama/… is not valid" now fails as an opaque
 *
 *     {"name":"UnknownError","data":{"message":"Unexpected server error…"}}
 *
 * so a config missing the map reads like a broken provider rather than a
 * misconfigured one. It cost #6125 an investigation; do not re-derive it. Two
 * OTHER failures land in the same "spawns, ~12s, no output" shape and are NOT
 * this one — `model '<id>' not found` (the daemon no longer holds that model,
 * which `services/providerReadiness.js` now reports up front) and
 * `<id> does not support tools` (a non-tool-capable model, which the
 * `_fetchOllamaToolCapableModels` refresh filters out of the provider's list).
 */

import {
  getOpencodeLocalProviderNamespace,
  isOpencodeCommand,
  prefixOpencodeModel,
  parseOpencodeConfigContent,
  OPENCODE_PUBLIC_REVIEW_AGENT,
} from './providerModels.js';
import { PROVIDER_GATEWAYS, PROVIDER_GATEWAY_IDS, gatewayById, isGatewayNamespace } from './providerGateways.js';
import { isPublicReviewNoToolProfile } from './agentExecutionProfiles.js';
import { isPlainObject } from './objects.js';
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

const asObject = (value) => (isPlainObject(value) ? value : {});

/**
 * The three OpenCode permissions that open an interactive gate: `question` (the
 * "Should I …? 1. Yes 2. No" selector), and `plan_enter` / `plan_exit` (the plan
 * agent's hand-back to a human). OpenCode denies all three in its OWN built-in
 * agent defaults, and `opencode run` re-denies them explicitly, precisely
 * because nothing can answer them without a person at the terminal.
 *
 * PortOS's config re-ENABLED them. A root `permission` is merged LAST into the
 * agent ruleset and resolved with `findLast`, so the blanket `permission:
 * "allow"` PortOS writes (and that every seeded provider record stores) wins
 * over the vendor denial for every key including these. A denied permission
 * also hides its tool from the model entirely (OpenCode's `visibleTools`), so
 * allowing it is what put the `question` tool back into the schema handed to a
 * local model — an unattended issues-watcher run on `qwen3-coder:30b` then
 * called it and parked on "Should I review these issue comments and PRs?" with
 * nobody there to press a key, burning its whole session. The
 * UNATTENDED_RUN_RULE in `services/agentPromptBuilder.js` tells the agent not
 * to ask; this makes asking unreachable.
 *
 * Every PortOS OpenCode spawn is unattended, so these stay denied
 * unconditionally — this is an enforcement boundary, not a default. The rest of
 * the blanket allow is kept: PortOS agents must not stall on an edit/bash
 * approval either.
 */
const INTERACTIVE_GATE_DENIALS = Object.freeze({
  question: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
});

/**
 * Re-apply {@link INTERACTIVE_GATE_DENIALS} on top of whatever root permission a
 * config carries. OpenCode accepts a string shorthand there (`"allow"`), which
 * it decodes to `{'*': <action>}`; that expansion happens here so the denials
 * have an object to be appended to.
 *
 * **Key order is the enforcement, not cosmetics.** OpenCode flattens the block
 * to a rule list in key order and resolves a permission with `findLast`, where a
 * `'*'` KEY matches every permission name — so the last rule wins outright,
 * specificity notwithstanding, and the denials only bind while they sit after
 * the wildcard. Overwriting a gate key in place would keep that key's ORIGINAL
 * position, so a stored `{ question: 'allow', '*': 'allow' }` would emit
 * `{ question: 'deny', '*': 'allow' }` and the trailing wildcard would allow
 * `question` right back. The gate keys are therefore DROPPED from the base and
 * re-appended, which puts them last whatever order the base used.
 *
 * Mutates and returns `config`; callers pass a config they already own.
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
 * The one field that is NOT purely preserved is the root `permission`: the
 * interactive-gate denials are re-applied over it (see `denyInteractiveGates`),
 * because a PortOS spawn has no human to answer a gate. Everything else the
 * base sets there survives.
 *
 * NOT the whole config: `small_model` is applied downstream by
 * `buildOpencodeEnvVars`, which is the only caller that knows THIS run's single
 * model (this one takes a list). A config built here alone is unpinned.
 *
 * @param {string|string[]|null|undefined} models
 * @param {object|null} [base] - existing config to merge into (a fresh clone is made)
 * @param {'ollama'|'mtplx'|'llama'|'vllm'|'sglang'|string} [providerKey='ollama']
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(models, base = null, providerKey = 'ollama', generation = null) {
  // `null` = the harness's OWN catalog (OpenCode Zen). There is no custom
  // provider entry to declare and no models map to fill — OpenCode already
  // knows those models and already holds the credential — so the provider half
  // of this builder is skipped and everything else (base preservation, the
  // agent generation block) applies unchanged. One path, not two.
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

// `'*'` is OpenCode's documented wildcard for a tool map; `deny` is its hard
// permission refusal (as opposed to `ask`, which in a headless `opencode run`
// would simply hang).
//
// At the ROOT the string shorthand is used rather than the per-action object:
// it denies EVERY permission category, including any OpenCode adds later, where
// naming `edit`/`bash`/`webfetch` explicitly would silently leave a new one at
// its default. The shorthand is the same form the shipped provider records
// already store (`{"permission":"allow"}`), so it is known-good. Per-agent
// entries keep the explicit object, which is the shape documented there.
const DENY_ALL_TOOLS = Object.freeze({ '*': false });
const DENY_ALL_PERMISSIONS = 'deny';
const DENY_ALL_AGENT_PERMISSIONS = Object.freeze({ edit: 'deny', bash: 'deny', webfetch: 'deny' });

/**
 * Harden an OpenCode config for the `no-tool` public-review posture.
 *
 * OpenCode has no argv equivalent of codex's `--sandbox read-only` or claude's
 * `--restricted --tools ''` — its tool posture lives entirely in the config —
 * so THIS is the vendor's enforced recipe, and `providerVendors.js` pairs it
 * with `run --agent plan`. Four controls, none of them redundant with another:
 *
 *   1. the root `permission` denies every category, covering any agent the
 *      config never names;
 *   2. every agent gets the same denials plus an emptied tool map — per-agent
 *      settings OVERRIDE the root block, and OpenCode's built-in `build` and
 *      `plan` agents carry tool maps of their own, so hardening only the root
 *      would leave those definitions in force;
 *   3. every declared model is marked `tool_call: false`, so OpenCode never
 *      advertises a tool schema to a local model in the first place;
 *   4. MCP servers and plugins are cleared, and session sharing and autoupdate
 *      are switched off, so nothing reaches the network on the side.
 *
 * A user's stored config is otherwise PRESERVED (base URLs, models, generation
 * settings) — this only overwrites the fields that carry the posture. Mutates
 * and returns `config`; callers pass a config they already own.
 *
 * @param {object} config
 * @returns {object} the same config, hardened
 */
function hardenOpencodeConfigForNoTool(config) {
  if (!isPlainObject(config)) return config;
  config.permission = DENY_ALL_PERMISSIONS;
  config.tools = { ...DENY_ALL_TOOLS };
  const agents = asObject(config.agent);
  const agentNames = new Set([...Object.keys(agents), 'build', OPENCODE_PUBLIC_REVIEW_AGENT]);
  // `buildAgentGeneration` writes the stage's temperature / topP / thinking /
  // reasoningEffort onto `agent.build` — OpenCode's default agent — but this
  // profile runs `--agent plan`. Seed the review agent from `build` so the
  // stage's configured effort actually reaches the model that runs, instead of
  // silently falling back to the backend default. An explicit `agent.plan` in
  // the user's own config still wins (it is spread after).
  const generationSource = asObject(agents.build);
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
 * Build dynamic env vars for an OpenCode spawn. Returns an object with
 * `OPENCODE_CONFIG_CONTENT` for a provider that names a backend namespace
 * (Ollama, MTPLX, llama.cpp, vLLM, SGLang, or a hosted gateway) — models map
 * declared — and for a NAMESPACE-LESS record that ships a stored config of its
 * own, which is how the seeded OpenCode Zen wrappers run on the harness's own
 * catalog: no provider entry to declare and no key to inject, just the base plus
 * the `small_model` pin. Otherwise an empty object (caller keeps existing env).
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
 * @param {{safetyProfile?:string|null}} [options] - a `no-tool` public-review
 *   profile applies `hardenOpencodeConfigForNoTool`, which IS OpenCode's
 *   enforced tool-free recipe (it has no argv equivalent).
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} env vars to merge
 */
export function buildOpencodeEnvVars(provider, model, { safetyProfile = null } = {}) {
  const providerKey = getOpencodeLocalProviderNamespace(provider);
  if (!isOpencodeCommand(provider?.command)) {
    return {};
  }
  // Parse the provider's stored config as the base so any user customization
  // (custom baseURL, permission, hand-maintained models) is preserved rather
  // than clobbered by the hardcoded localhost default.
  const base = parseOpencodeConfigContent(provider?.envVars?.OPENCODE_CONFIG_CONTENT);
  // A record with NO namespace and NO stored config is a hand-made plain
  // `opencode` provider: it has always run against the user's own
  // `~/.config/opencode`, and `OPENCODE_CONFIG_CONTENT` REPLACES that file
  // wholesale — synthesizing one here would silently drop every provider they
  // declared in it. The seeded Zen records ship `{"permission":"allow"}`, so
  // they take the path below and get the `small_model` pin merged into it.
  if (!providerKey && !base) return {};

  const ids = [
    ...(Array.isArray(provider?.models) ? provider.models : []),
    provider?.defaultModel,
    model,
  ];
  const config = buildOpencodeConfig(ids, base, providerKey, provider);
  // Pin the auxiliary model OpenCode uses for its OWN side work (session titles,
  // summarization). Left unset it falls back to its built-in default, which is a
  // real hosted model nobody here chose — an OpenRouter run on the free
  // `stealth/ox-alpha` otherwise emits paid `google/gemini-3.7-flash` calls
  // alongside it, and a local run on a box carrying an `ANTHROPIC_API_KEY` /
  // `OPENAI_API_KEY` (spawns inherit `process.env`, see `cliChildEnv.js`) can
  // reach a cloud provider the operator never opted into — exactly the
  // unrequested provider call the root AGENTS.md's AI Provider Usage Policy
  // forbids.
  //
  // So this is unconditional, not gateway-only: the invariant is that a run stays
  // on the model it was dispatched with, and it holds for every namespace. The
  // run model is always in the declared models map above, so it always resolves.
  // A stored config that already pins `small_model` wins — same
  // customization-preserving contract as the base merge above.
  if (!config.small_model && model) {
    config.small_model = prefixOpencodeModel(provider, model);
  }
  // Every key-bearing namespace reads the SAME `provider.apiKey` field; a
  // gateway's `legacyApiKeyField` (`orcarouterApiKey`) is an older alias kept
  // readable forever. vLLM's compose stack is started with `VLLM_API_KEY`, so a
  // wrapper pointed at it needs the key on `options.apiKey` exactly the way a
  // hosted gateway does — the endpoint is loopback, but the server still 401s
  // without it.
  // Keyed off the RESOLVED namespace, not the record's marker: a malformed
  // record carrying both a local marker and a gateway marker resolves to the
  // local namespace above, and must not then export a gateway key env var.
  // A null namespace declares no provider entry, so there is nowhere to attach a
  // key and nothing that needs one — OpenCode authenticates the harness's own
  // catalog itself.
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
  // LAST, so it overrides every field composed above — including a stored
  // `permission: "allow"` and the `tool_call: true` the models map is built
  // with. This is the enforcement boundary, not a default.
  if (isPublicReviewNoToolProfile(safetyProfile)) hardenOpencodeConfigForNoTool(config);
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    ...(apiKey && gateway ? { [gateway.apiKeyEnv]: apiKey } : {}),
  };
}
