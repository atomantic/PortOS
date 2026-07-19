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

/**
 * True when a provider is codex-flavored — the shipped `codex`/`codex-tui` ids
 * or any provider whose launch command basename is `codex` (path/exe tolerant).
 * MIRROR of `isCodexProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isCodexProvider = (provider) => {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'codex' || id === 'codex-tui' || commandBasename(provider?.command) === 'codex';
};

export const knownProviderContextWindow = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const id = String(provider?.id || '').toLowerCase();
  const command = commandBasename(provider?.command);
  if (isCodexProvider(provider)) return CODEX_CONTEXT_WINDOW;
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
 * Reasoning-effort levels per effort-capable CLI — MIRROR of
 * `CLAUDE_EFFORT_LEVELS` / `CODEX_EFFORT_LEVELS` / `effortLevelsForProvider` in
 * server/lib/providerModels.js; keep in lockstep. Claude Code takes
 * `--effort <level>`, Codex takes `-c model_reasoning_effort=<level>`.
 */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * The effort levels a provider's CLI accepts, or null when the provider has no
 * effort control (antigravity, opencode, grok, HTTP API providers). Keyed on
 * the launch command basename plus the shipped provider ids, so path-configured
 * or renamed claude/codex providers still qualify. Drives the "Effort
 * (optional)" select in task/schedule forms.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {readonly string[]|null}
 */
export const effortLevelsForProvider = (provider) => {
  if (!provider) return null;
  if (isCodexProvider(provider)) return CODEX_EFFORT_LEVELS;
  const id = String(provider.id || '').toLowerCase();
  if (id.startsWith('claude-code') || commandBasename(provider.command) === 'claude') return CLAUDE_EFFORT_LEVELS;
  return null;
};

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
 * Agent-picker tool-use annotation for a model id. Agent / CoS tasks (the CD
 * treatment + plan stages, coding agents) only work with a model that can emit
 * native tool calls — a local model that can't (e.g. Gemma) narrates a
 * done-message instead of acting, silently wedging the task. This decides the
 * per-option marker + the "pick a tool-capable model" warning in agent pickers.
 *
 * Returns `null` for cloud / API providers: their model ids don't encode their
 * family, so the name heuristic would mislabel them (same reason
 * `toolUseLocalModelFilter` leaves cloud lists untouched). LOCAL backends return
 * `{ toolCapable }` keyed on {@link isToolUseModel} — where "local" is BOTH a
 * direct Ollama / LM Studio backend ({@link localBackendForProvider}) AND an
 * Ollama-BACKED CLI/TUI wrapper ({@link isOllamaBackedProvider}): a renamed
 * `claude-ollama-tui` / OpenCode wrapper keeps `ollamaBacked: true` but may lose
 * the "ollama" name/endpoint/id that `localBackendForProvider` matches on, and
 * that wrapper is exactly the incident's provider class — so it must still be
 * flagged, not silently skipped.
 * @param {string} id
 * @param {object} [provider]
 * @returns {{toolCapable:boolean}|null}
 */
export const localToolUseHint = (id, provider) =>
  (localBackendForProvider(provider) || isOllamaBackedProvider(provider))
    && typeof id === 'string' && id.length > 0
    ? { toolCapable: isToolUseModel(id) }
    : null;

/**
 * Suffix a native `<option>` label with a tool-use marker for an agent picker.
 * No-op (returns `label` unchanged) for cloud providers or a blank id, so it's
 * safe to wrap every option. Pairs with {@link localToolUseHint} for the
 * below-the-select warning. Emoji (not lucide icons) because native `<option>`
 * elements can't render markup.
 *
 * The signal is asymmetric because {@link isToolUseModel} is a *positive
 * allowlist* of families with dependable function-calling: a match is a reliable
 * "tool-capable", but a NON-match only means "not a recognized tool-caller" —
 * NOT a proven negative (a newer tool-capable family whose id isn't in the regex
 * yet would fall here). So the negative marker is worded as unverified, not a
 * false-certain "no tool use".
 * @param {string} id - model id (drives the heuristic)
 * @param {string} label - display label to annotate (often === id)
 * @param {object} [provider] - the selected provider object
 * @returns {string}
 */
export const withToolUseOptionLabel = (id, label, provider) => {
  const hint = localToolUseHint(id, provider);
  if (!hint) return label;
  return `${label}${hint.toolCapable ? ' · 🔧 tool use' : ' · ⚠ no known tool use'}`;
};

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
 *
 * `visionIdsByProvider` is the AUTHORITATIVE map the server reports from each
 * backend's own capability metadata (Ollama `/api/show`, LM Studio
 * `type: 'vlm'`), keyed by the PROVIDER ID the server says serves each model —
 * see `useVisionModelIds`. It is unioned with, not substituted for, the id
 * regex: the regex alone goes stale every time a new multimodal family ships
 * (it knew `gemma-3` but not `gemma4`, so a user with only `gemma4:e4b` +
 * `qwen3.6:35b` installed saw an EMPTY vision picker), while the map alone
 * can't speak for a provider the server never enumerated. Pass `null` (the
 * default) when it hasn't loaded — that degrades to regex-only.
 *
 * Keyed by the ENUMERATED PROVIDER, not flattened and not keyed by backend,
 * because a bare id is not a capability:
 *   - The same id can be a VLM on one backend and text-only on another, and the
 *     server also reports `backend: 'cli'` rows asserting vision for EVERY model
 *     of a claude/codex CLI (that CLI reads an image file whatever model it
 *     fronts). Flattening let an ollama-backed Claude CLI's text-only ids — which
 *     collide with the real `ollama` provider's list — pass this filter.
 *   - Keying by backend alone still over-shares: a CUSTOM provider pointed at a
 *     *different* Ollama/LM Studio host (endpoint `:11434` on another machine)
 *     resolves to the same backend, but the server never enumerated that host,
 *     so a local VLM's id would vouch for a remote model that merely shares it.
 * An unenumerated local provider therefore stays on the regex-only path. This
 * matters because sceneEvaluator honors a pin's model verbatim — a wrong yes
 * here sends frames to a model that cannot see them.
 *
 * @param {string} id
 * @param {{id?:string,endpoint?:string,name?:string}} [provider]
 * @param {Record<string, Set<string>>|null} [visionIdsByProvider]
 * @returns {boolean}
 */
export const visionLocalModelFilter = (id, provider, visionIdsByProvider = null) => {
  // Cloud/API providers are left intact — the regex is a local-name heuristic
  // and would wrongly hide multimodal cloud ids like `gpt-4o`.
  if (!localBackendForProvider(provider)) return true;
  return visionIdsByProvider?.[provider?.id]?.has(id) === true || isVisionModel(id);
};

/**
 * Classify a provider as a local-LLM backend by its id/endpoint/name, so callers
 * can fold in live-installed models (Ollama/LM Studio) that aren't in the
 * provider's stored `models` list. Ollama's native + OpenAI-compat ports are
 * 11434; LM Studio defaults to 1234. The stable provider ids (`ollama` /
 * `lmstudio`) are checked too — AI Assignments' curated provider payload
 * omits `endpoint`, and a renamed display name would otherwise miss detection.
 * @param {{id?:string,endpoint?:string,name?:string}} provider
 * @returns {'ollama'|'lmstudio'|null}
 */
export const localBackendForProvider = (provider) => {
  if (!provider) return null;
  const id = String(provider.id || '').toLowerCase();
  const endpoint = String(provider.endpoint || '');
  const name = String(provider.name || '').toLowerCase();
  if (id === 'ollama' || /:11434\b/.test(endpoint) || name.includes('ollama')) return 'ollama';
  if (
    id === 'lmstudio' ||
    /:1234\b/.test(endpoint) ||
    name.includes('lm studio') ||
    name.includes('lmstudio') ||
    /lm[\s-]?studio/i.test(name)
  ) return 'lmstudio';
  return null;
};

const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i;
export const isLocalEndpoint = (endpoint) =>
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
 * Check if a provider is the Grok Build CLI/TUI (the `grok` command harness).
 * Mirrors the Grok detection in `knownProviderContextWindow`: matches the shipped
 * `grok-cli` / `grok-tui` samples or any process provider whose command basename
 * is `grok`. Used to surface the `~/.grok/config.toml` privacy notice: the Grok
 * harness uploads the entire working repo to xAI/GCP as it works unless the user
 * opts out via `[harness] disable_codebase_upload = true`. The plain `grok` API
 * provider (type `api`) doesn't run the harness, so it's intentionally excluded.
 */
export const isGrokBuildCli = (provider) => {
  if (!isProcessProvider(provider)) return false;
  const id = String(provider?.id || '').toLowerCase();
  return id === 'grok-cli' || id === 'grok-tui' || commandBasename(provider?.command) === 'grok';
};

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
 *
 * When `entry.modelFilter === 'vision'`, LOCAL backends (Ollama / LM Studio)
 * are reduced to vision-capable models via `visionLocalModelFilter` so the
 * Scene Evaluation (and other vision) pickers can't offer text-only ids.
 * Cloud/API providers are left intact by that filter. Pass `visionIdsByProvider`
 * (from `useVisionModelIds`) so that reduction uses the backend's own capability
 * metadata instead of the id regex alone.
 *
 * For a vision entry on an ENUMERATED local provider, the server's installed-VLM
 * list is also UNIONED INTO the candidates rather than only filtering them: a
 * provider's stored `models` is a snapshot that goes stale the moment the user
 * pulls a model (`/local-llm/install` doesn't refresh it, and the shipped
 * `ollama` provider starts out empty), so filtering that list alone still hides
 * a VLM that is installed right now — the same staleness `useLocalModels` +
 * `mergeModelLists` exists to solve for non-vision pickers. Only the provider
 * the server actually enumerated gets this: an unenumerated one would otherwise
 * be offered models from a host it doesn't serve.
 */
export const assignmentModelOptions = (entry, providers, providerId, visionIdsByProvider = null) => {
  const provider = providers.find((p) => p.id === providerId);
  const baked = Array.isArray(entry?.modelOptions);
  const raw = baked ? entry.modelOptions : (provider?.models || []);
  // Normalize object-shaped entries (`{ id }`) so both baked and live lists
  // yield plain string options for the <select>.
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter(Boolean);
  if (entry?.modelFilter !== 'vision') return models;
  // Pre-baked `modelOptions` is an explicit caller-supplied list — honor it as
  // the full candidate set rather than widening it from the backend.
  const installed = baked ? null : visionIdsByProvider?.[providerId];
  const candidates = installed ? mergeModelLists(models, [...installed]) : models;
  return candidates.filter((id) => visionLocalModelFilter(id, provider, visionIdsByProvider));
};

/**
 * Default model to seed when the user picks a provider for an assignment.
 * For vision-filtered entries, only returns a model that still appears in the
 * filtered options — a local backend's text-only `defaultModel` must not be
 * seeded into the Scene Evaluation picker.
 */
export const assignmentDefaultModel = (entry, providers, providerId, visionIdsByProvider = null) => {
  if (!providerId) return '';
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return '';
  const def = provider.defaultModel || '';
  if (entry?.modelFilter !== 'vision') return def;
  const models = assignmentModelOptions(entry, providers, providerId, visionIdsByProvider);
  if (def && models.includes(def)) return def;
  return models[0] || '';
};
