import { formatContextLength } from './formatters.js';

/**
 * Sentinel value used by the Codex provider to indicate the model is configured
 * via ~/.codex/config.toml rather than PortOS. Filter this out of selectable
 * model lists so the UI shows the explanatory note instead of a token dropdown.
 */
export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
export const GROK_CONFIGURED_DEFAULT = 'grok-configured-default';

const CONFIGURED_DEFAULT_SENTINELS = new Set([
  CODEX_CONFIGURED_DEFAULT,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
]);

/** True for any provider "use CLI's own default" sentinel. Mirror of server `isConfiguredDefaultModel`. */
export const isConfiguredDefaultModel = (model) => CONFIGURED_DEFAULT_SENTINELS.has(model);

export const DEFAULT_LARGE_CONTEXT_WINDOW = 128_000;
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const GEMINI_CONTEXT_WINDOW = 1_048_576;
export const GROK_CONTEXT_WINDOW = 256_000;

// Keep in sync with server/lib/stageRunner.js.
const KNOWN_MODEL_CONTEXT_WINDOWS = Object.freeze([
  [/gpt[-_.:/]?5\.5(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/gpt[-_.:/]?5\.4[-_.:/]?mini(?:[-_.:/]|\b)/i, 400_000],
  [/gpt[-_.:/]?5\.4(?![-_.:/]?(?:mini|nano))(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/claude[-_.:/]?fable[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?mythos[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?opus[-_.:/]?4[-_.:/]?8/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4[-_.:/]?6(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?sonnet[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/claude[-_.:/]?haiku[-_.:/]?4(?:[-_.:/]|\b)/i, 200_000],
  [/gemini[-_.:/]?2\.5[-_.:/]?pro(?:[-_.:/]|\b)/i, GEMINI_CONTEXT_WINDOW],
]);

export const knownModelContextWindow = (model) => {
  if (typeof model !== 'string' || !model.trim()) return null;
  const found = KNOWN_MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return found ? found[1] : null;
};

// Inline mirror of server/lib/providerModels.js#commandBasename — the client can't
// import server-side modules. Strip the directory + a Windows `.exe` suffix so a
// path-configured command (/opt/homebrew/bin/grok) matches the bare vendor name.
// Keep in lockstep with the server helper (only `.exe` is stripped, not `.cmd`).
const commandBasename = (command) =>
  typeof command === 'string' && command !== ''
    ? command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
    : '';

export const knownProviderContextWindow = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const id = String(provider?.id || '').toLowerCase();
  const command = commandBasename(provider?.command);
  if (id === 'codex' || id === 'codex-tui' || command === 'codex') return CODEX_CONTEXT_WINDOW;
  if (id === 'antigravity-cli' || id === 'antigravity-tui' || command === 'agy') return GEMINI_CONTEXT_WINDOW;
  if (id === 'grok-cli' || id === 'grok-tui' || command === 'grok') return GROK_CONTEXT_WINDOW;
  return null;
};

/**
 * Provider-type enum mirrored from server/lib/aiToolkit/constants.js#PROVIDER_TYPES.
 * The aiToolkit directory is kept self-contained (no imports out to other PortOS
 * modules) so the client cannot import the server copy directly — keep these two
 * in lockstep when adding a type. The provider type predicates below and the
 * Tailwind chip helper read from this object, so a string literal only needs to
 * appear once per side.
 */
export const PROVIDER_TYPES = Object.freeze({
  CLI: 'cli',
  TUI: 'tui',
  API: 'api'
});

/**
 * Returns the provider's model list with internal sentinel values removed.
 * Use this anywhere a list of user-selectable models is needed.
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterSelectableModels = (models) =>
  (models || []).filter(m => !isConfiguredDefaultModel(m));

/**
 * Embedding-only model detector — mirror of `isEmbeddingModel` in
 * server/lib/localModelHeuristics.js. Keep the two regexes in lockstep (the
 * server lib can't be imported here). Used to keep embedding models (e.g.
 * `nomic-embed-text`) out of generation/chat model pickers.
 * @param {string} id
 * @returns {boolean}
 */
export const isEmbeddingModel = (id) =>
  typeof id === 'string' && id.length > 0 &&
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5|snowflake-arctic-embed)(?:[-_/:]|$)|text-embedding/i.test(id);

/**
 * Vision-capable (multimodal) model detector — mirror of `isVisionModel` in
 * server/lib/localModelHeuristics.js (id-regex branch only). Keep the regex in
 * lockstep with the server. Used to flag/select vision models in the LoRA
 * caption picker. The server prefers explicit backend capability metadata
 * (`vision: true` on the model card); use that field when you have it and fall
 * back to this for bare id strings.
 * @param {string} id
 * @returns {boolean}
 */
export const isVisionModel = (id) =>
  typeof id === 'string' && id.length > 0 &&
  // Mirror of VISION_RE in server/lib/localModelHeuristics.js — keep in lockstep.
  /(?:^|[-_/:])vision(?:[-_/:.]|$)|(?:^|[-_/:])vl(?:\d|[-_/:.]|$)|qwen[\d.]*-?vl|llava|bakllava|moondream|minicpm-?v|pixtral|gemma-?3|smolvlm|internvl|cogvlm|glm-?4v|phi-?3\.5?-vision|phi-?4-multimodal|got-ocr|idefics|fuyu|paligemma|kosmos|nanollava/i.test(id);

/**
 * Tool-use (function-calling) capable model detector — mirror of `isToolUseModel`
 * in server/lib/localModelHeuristics.js (and the TOOL_USE_RE inlined in
 * server/lib/aiToolkit/providers.js). Keep all three in lockstep (the server libs
 * can't be imported here). Ollama's /api/show `tools` capability is authoritative
 * when known; this id regex is the fallback for bare model-id strings. The CoS
 * agent harness depends on reliable tool-calling, so only these families should
 * be selectable for a local-model-backed coding provider.
 * @param {string} id
 * @returns {boolean}
 */
export const isToolUseModel = (id) =>
  typeof id === 'string' && id.length > 0 &&
  // Mirror of TOOL_USE_RE in server/lib/localModelHeuristics.js — keep in lockstep.
  /qwen|llama-?3\.[1-9]|llama-?4|mistral|mixtral|ministral|codestral|devstral|magistral|command-?r|command-?a|firefunction|functionary|watt-tool|hermes|glm-?4|granite-?3|gpt-oss|nemotron|smollm2|deepseek-v3|deepseek-r1/i.test(id);

/**
 * Per-model filter for a CODING / tool-use picker: restrict LOCAL backends
 * (Ollama / LM Studio) to tool-use-capable models by id, but leave cloud/API
 * providers' lists untouched — `isToolUseModel` is a local-name heuristic and
 * would wrongly hide capable cloud models whose ids don't encode their family.
 * Mirrors `visionLocalModelFilter`. Pass as
 * `useProviderModels({ modelFilter: toolUseLocalModelFilter })`.
 * @param {string} id
 * @param {{endpoint?:string,name?:string}} [provider]
 * @returns {boolean}
 */
export const toolUseLocalModelFilter = (id, provider) =>
  localBackendForProvider(provider) ? isToolUseModel(id) : true;

/**
 * Selectable models for a generation/chat picker: drops internal sentinels AND
 * embedding-only models. Use anywhere the user picks a model that will run a
 * prompt (provider editor model lists, fallback model, manuscript review).
 * @param {string[]} models
 * @returns {string[]}
 */
export const filterGenerationModels = (models) =>
  filterSelectableModels(models).filter((m) => !isEmbeddingModel(m));

/**
 * Per-model filter for a VISION picker: restrict LOCAL backends (Ollama /
 * LM Studio) to vision-capable models by id, but leave cloud/API providers'
 * lists untouched — `isVisionModel` is a local-name heuristic and would wrongly
 * hide multimodal cloud models whose ids don't encode vision (`gpt-4o`,
 * `claude-*`). Pass as `useProviderModels({ modelFilter: visionLocalModelFilter })`.
 * @param {string} id
 * @param {{endpoint?:string,name?:string}} [provider]
 * @returns {boolean}
 */
export const visionLocalModelFilter = (id, provider) =>
  localBackendForProvider(provider) ? isVisionModel(id) : true;

/**
 * Classify a provider as a local-LLM backend by its endpoint/name, so callers
 * can fold in live-installed models (Ollama/LM Studio) that aren't in the
 * provider's stored `models` list. Ollama's native + OpenAI-compat ports are
 * 11434; LM Studio defaults to 1234.
 * @param {{endpoint?:string,name?:string}} provider
 * @returns {'ollama'|'lmstudio'|null}
 */
export const localBackendForProvider = (provider) => {
  const endpoint = String(provider?.endpoint || '');
  const name = String(provider?.name || '').toLowerCase();
  if (/:11434\b/.test(endpoint) || name.includes('ollama')) return 'ollama';
  if (/:1234\b/.test(endpoint) || name.includes('lm studio') || name.includes('lmstudio')) return 'lmstudio';
  return null;
};

const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
const isLocalEndpoint = (endpoint) =>
  typeof endpoint === 'string' && LOCAL_ENDPOINT_RE.test(endpoint.trim());

export const isLikelyLargeContextProvider = (provider) => {
  if (isProcessProvider(provider)) return true;
  return isApiProvider(provider) && !isLocalEndpoint(provider.endpoint);
};

export const effectiveModelContextWindow = (provider, model) => {
  const explicit = Number(provider?.contextWindow);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const known = knownModelContextWindow(model);
  if (known) return known;
  const providerKnown = knownProviderContextWindow(provider);
  if (providerKnown) return providerKnown;
  const numCtx = Number(provider?.numCtx);
  if (Number.isFinite(numCtx) && numCtx > 0) return numCtx;
  return isLikelyLargeContextProvider(provider) ? DEFAULT_LARGE_CONTEXT_WINDOW : null;
};

/**
 * Union of one or more model-id lists, de-duplicated, order-preserving, falsy
 * values dropped. Used to merge a provider's stored `models` with the live
 * installed list for local backends.
 * @param {...(string[]|undefined)} lists
 * @returns {string[]}
 */
export const mergeModelLists = (...lists) => {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const m of list || []) {
      if (m && !seen.has(m)) { seen.add(m); out.push(m); }
    }
  }
  return out;
};

/**
 * Display label for a model `<option>`: the id plus a "(32K ctx)" parenthetical
 * when the model's context window is known (local models, via the `ctxById` map
 * from `useLocalModels`). The option's `value` stays the raw id — only the label
 * carries the annotation.
 * @param {string} id
 * @param {Record<string, number>} [ctxById]
 * @returns {string}
 */
export const modelOptionLabel = (id, ctxById) => {
  const ctx = ctxById?.[id] || knownModelContextWindow(id);
  const label = formatContextLength(ctx);
  return label ? `${id} (${label})` : id;
};

/**
 * Check if a provider is a TUI-backed agent provider. Mirror of
 * `isTuiProvider` in server/services/agentCliSpawning.js.
 */
export const isTuiProvider = (provider) => provider?.type === PROVIDER_TYPES.TUI;

/**
 * Check if a provider is a one-shot CLI agent provider.
 */
export const isCliProvider = (provider) => provider?.type === PROVIDER_TYPES.CLI;

/**
 * Check if a provider is an HTTP-API provider (e.g. OpenAI, Anthropic, LM Studio),
 * as opposed to a process-backed CLI/TUI agent. Use this anywhere you'd write
 * `provider.type === PROVIDER_TYPES.API` against a saved provider.
 */
export const isApiProvider = (provider) => provider?.type === PROVIDER_TYPES.API;

/**
 * Stable, module-scoped filter for `useProviderModels({ filter })` and other
 * call sites that need "enabled HTTP-API providers only". Hoisted so the
 * identity is the same across renders (callers may pass it as a dependency).
 */
export const enabledApiProviderFilter = (provider) => Boolean(provider?.enabled) && isApiProvider(provider);

/**
 * Check if a provider is process-backed (cli or tui), as opposed to an
 * HTTP-API provider. Use this for "shows a Command + args" config predicates.
 */
export const isProcessProvider = (provider) => isCliProvider(provider) || isTuiProvider(provider);

/**
 * A `claude` CLI/TUI provider is "Ollama-backed" — the Claude Ollama pattern —
 * when it carries the `ollamaBacked` marker or its ANTHROPIC_BASE_URL points at
 * an Ollama daemon. Such a provider runs the Claude Code harness but generates
 * tokens locally, so its model list is refreshed from Ollama (including the TUI
 * variant, which the server refreshes via the `type==='tui' && ollamaBacked`
 * branch). MIRROR of `isOllamaBackedProvider` in server/lib/aiToolkit/providers.js.
 * @param {{ollamaBacked?:boolean,envVars?:Record<string,string>}} provider
 */
export const isOllamaBackedProvider = (provider) => {
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
};

/**
 * Check if a provider is the headless Claude Code CLI (`claude --print`) whose
 * *provider-level config* points it at a Claude Code subscription plan — i.e. the
 * provider's own `envVars` do NOT route it through Bedrock or Vertex (those bill
 * via the cloud account, not the plan). Used to surface the billing-change warning:
 * starting 2026-06-15 Anthropic clocks this non-interactive usage under API billing
 * (consuming API credits) instead of the Claude Code plan, so it should be avoided
 * in favor of the interactive Claude Code TUI provider.
 *
 * Contract is intentionally provider-level only: this is a client-side heuristic
 * that sees just the saved provider record. A user who routes the spawn to
 * Bedrock/Vertex *globally* via `~/.claude/settings.json` (merged below
 * `provider.envVars` in `server/services/agentCliSpawning.js`) rather than on the
 * provider would be cloud-billed but still match here. Configure Bedrock/Vertex on
 * the provider's `envVars` (as the shipped `claude-code-bedrock` sample does) to
 * suppress the warning.
 */
export const isClaudeCodePlanCli = (provider) =>
  isCliProvider(provider) &&
  provider?.command === 'claude' &&
  // Ollama-backed Claude (the "Claude Ollama" sample) routes generation to a
  // local daemon via ANTHROPIC_BASE_URL — it's never plan/API-billed, so the
  // billing warning would be misleading and discourage the shipped local setup.
  !isOllamaBackedProvider(provider) &&
  !provider?.envVars?.CLAUDE_CODE_USE_BEDROCK &&
  !provider?.envVars?.CLAUDE_CODE_USE_VERTEX;

/**
 * Resolve the provider whose timeout is the "fallback" for a stage — the
 * stage's pinned provider when set, otherwise the active provider. Used to
 * power the placeholder + hint on stage-timeout UIs in PromptManager and
 * the Writers Room. Returns the timeout in ms (or `undefined` if neither
 * provider is present, or its timeout isn't set).
 */
export const getProviderTimeout = (providers, stagePinnedId, activeProviderId) => {
  const id = stagePinnedId || activeProviderId;
  if (!id) return undefined;
  return providers.find((p) => p.id === id)?.timeout;
};

/**
 * Tailwind chip classes for the provider type badge ('cli' / 'tui' / 'api').
 * Lifted out of AIProviders.jsx so other components can render the same
 * color treatment without redefining it.
 */
export const providerTypeClass = (type) => {
  if (type === PROVIDER_TYPES.CLI) return 'bg-blue-500/20 text-blue-400';
  if (type === PROVIDER_TYPES.TUI) return 'bg-emerald-500/20 text-emerald-400';
  return 'bg-purple-500/20 text-purple-400';
};

// ---------------------------------------------------------------------------
// AI Assignments option helpers — shared by the global AI Assignments table
// (settings/AiAssignmentsTab.jsx) and per-record override drawers (e.g. the
// Creative Director Models drawer). All three consume the `getAiAssignments`
// payload shape (`{ providers, assignments }`), where an assignment `entry` may
// carry `providerTypes` (which provider kinds are eligible) and optional
// pre-baked `providerOptions` / `modelOptions` overrides for runtime call sites.
// ---------------------------------------------------------------------------

/** Display name for a provider id, falling back to the id then `fallback`. */
export const providerDisplayName = (providers, id, fallback = '') =>
  providers.find((p) => p.id === id)?.name || id || fallback;

/**
 * Provider `{ id, name }` options eligible for an assignment entry — the entry's
 * pre-baked `providerOptions` when present, else every provider whose `type` is
 * in the entry's `providerTypes` (all providers when unfiltered), tagged with a
 * "(disabled)" suffix on disabled providers.
 */
export const assignmentProviderOptions = (entry, providers) => {
  if (Array.isArray(entry?.providerOptions)) return entry.providerOptions;
  const types = Array.isArray(entry?.providerTypes) && entry.providerTypes.length
    ? new Set(entry.providerTypes)
    : null;
  return providers
    .filter((p) => !types || types.has(p.type))
    .map((p) => ({ id: p.id, name: `${p.name}${p.enabled ? '' : ' (disabled)'}` }));
};

/**
 * Model-id options for an assignment entry given the selected provider — the
 * entry's pre-baked `modelOptions` when present, else the provider's own model
 * list (empty when the provider is unknown or has none).
 */
export const assignmentModelOptions = (entry, providers, providerId) => {
  if (Array.isArray(entry?.modelOptions)) return entry.modelOptions;
  return providers.find((p) => p.id === providerId)?.models || [];
};
