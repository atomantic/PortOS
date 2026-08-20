import { formatContextLength } from './formatters.js';

/**
 * Sentinel value used by the Codex provider to indicate the model is configured
 * via ~/.codex/config.toml rather than PortOS. Filter this out of selectable
 * model lists so the UI shows the explanatory note instead of a token dropdown.
 */
export const CODEX_CONFIGURED_DEFAULT = 'codex-configured-default';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';
export const GROK_CONFIGURED_DEFAULT = 'grok-configured-default';
export const KIMI_CONFIGURED_DEFAULT = 'kimi-configured-default';

const CONFIGURED_DEFAULT_SENTINELS = new Set([
  CODEX_CONFIGURED_DEFAULT,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  KIMI_CONFIGURED_DEFAULT,
]);

/** True for any provider "use CLI's own default" sentinel. Mirror of server `isConfiguredDefaultModel`. */
export const isConfiguredDefaultModel = (model) => CONFIGURED_DEFAULT_SENTINELS.has(model);

/**
 * The configured-default sentinel carried in a provider's model list, or null.
 *
 * `filterSelectableModels` strips sentinels from every picker, which is right
 * for a *task's* model choice ("no override" is the empty option there). But a
 * provider whose `defaultModel`/`lightModel`/… IS the sentinel while its
 * `models` also holds real ids (Antigravity: `agy` has a real catalog AND its
 * own configured default) would otherwise drive a `<select>` whose value
 * matches no `<option>` — the field renders blank and reads as "unset" when the
 * CLI's own default is in fact what's configured. The provider-edit form uses
 * this to render an explicit option for it.
 * @param {string[]|null|undefined} models
 * @returns {string|null}
 */
export const configuredDefaultIn = (models) =>
  (models || []).find(isConfiguredDefaultModel) || null;

export const DEFAULT_LARGE_CONTEXT_WINDOW = 128_000;
export const CODEX_CONTEXT_WINDOW = 1_000_000;
export const GEMINI_CONTEXT_WINDOW = 1_048_576;
export const GROK_CONTEXT_WINDOW = 256_000;
export const KIMI_CONTEXT_WINDOW = 256_000;

// Keep in sync with server/lib/stageRunner.js.
const KNOWN_MODEL_CONTEXT_WINDOWS = Object.freeze([
  [/gpt[-_.:/]?5\.5(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/gpt[-_.:/]?5\.4[-_.:/]?mini(?:[-_.:/]|\b)/i, 400_000],
  [/gpt[-_.:/]?5\.4(?![-_.:/]?(?:mini|nano))(?:[-_.:/]|\b)/i, CODEX_CONTEXT_WINDOW],
  [/claude[-_.:/]?fable[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?mythos[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
  [/claude[-_.:/]?opus[-_.:/]?5(?:[-_.:/]|\b)/i, 1_000_000],
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

/**
 * True when a provider is Kimi-Code-flavored — the shipped `kimi-cli`/`kimi-tui`
 * ids or any provider whose launch command basename is `kimi` (path/exe tolerant).
 * MIRROR of `isKimiProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isKimiProvider = (provider) => {
  const id = String(provider?.id || '').toLowerCase();
  return id === 'kimi-cli' || id === 'kimi-tui' || commandBasename(provider?.command) === 'kimi';
};

/**
 * True when a provider is Antigravity-flavored — the shipped
 * `antigravity-cli`/`antigravity-tui` ids or any provider whose launch command
 * basename is `agy`/`antigravity` (path/exe tolerant). MIRROR of
 * `isAntigravityProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isAntigravityProvider = (provider) => {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  if (id === 'antigravity-cli' || id === 'antigravity-tui') return true;
  const base = commandBasename(provider.command);
  return base === 'agy' || base === 'antigravity';
};

/**
 * True when a provider is Cursor-Agent-flavored — the shipped
 * `cursor-cli`/`cursor-tui` ids or any provider whose launch command basename is
 * `cursor-agent` (never a bare `cursor`, which is the GUI editor). MIRROR of
 * `isCursorProvider` in server/lib/providerModels.js — keep in lockstep.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isCursorProvider = (provider) => {
  if (!provider) return false;
  const id = String(provider.id || '').toLowerCase();
  return id === 'cursor-cli' || id === 'cursor-tui' || commandBasename(provider.command) === 'cursor-agent';
};

/**
 * Whether the AI Providers page should offer a "Refresh Models" button for this
 * provider — i.e. whether the server has a model fetcher that can answer for it.
 *
 * Reads the server's own answer off the payload. `canRefreshModels` is derived
 * on read from the per-vendor fetcher table
 * (`server/lib/aiToolkit/internal/modelFetchers.js`) and decorated onto every
 * provider-shaped response in `routes/providers.js`, so there is exactly one
 * definition of "refreshable" and it lives next to the dispatch that has to
 * honor it.
 *
 * This used to be a ~40-line hand-written mirror of both server dispatch arms,
 * kept in lockstep by a comment. It drifted in both directions: too generous
 * showed a button that 404'd, too stingy hid the feature with no error at all.
 * Strict `=== true` so a legacy payload from an older server (no such field)
 * hides the button rather than offering one that 404s.
 * @param {{canRefreshModels?:boolean}|null|undefined} provider
 * @returns {boolean}
 */
export const supportsModelRefresh = (provider) => provider?.canRefreshModels === true;

export const knownProviderContextWindow = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const id = String(provider?.id || '').toLowerCase();
  const command = commandBasename(provider?.command);
  if (isCodexProvider(provider)) return CODEX_CONTEXT_WINDOW;
  if (id === 'antigravity-cli' || id === 'antigravity-tui' || command === 'agy') return GEMINI_CONTEXT_WINDOW;
  if (id === 'grok-cli' || id === 'grok-tui' || command === 'grok') return GROK_CONTEXT_WINDOW;
  if (id === 'kimi-cli' || id === 'kimi-tui' || command === 'kimi') return KIMI_CONTEXT_WINDOW;
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
 * `CLAUDE_EFFORT_LEVELS` / `CODEX_EFFORT_LEVELS` / `ANTIGRAVITY_EFFORT_LEVELS` /
 * `effortLevelsForProvider` in server/lib/providerModels.js; keep in lockstep.
 * Claude Code and agy take `--effort <level>`, Codex takes
 * `-c model_reasoning_effort=<level>`.
 *
 * Codex's config enum includes `max` alongside
 * `none|minimal|low|medium|high|xhigh`. `ultra` is retained only as a legacy
 * stored value and resolves to `max` when sent to codex.
 */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const ANTIGRAVITY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
// OpenCode passes this through as `reasoningEffort` to its configured local
// provider. Ollama's OpenAI-compatible API accepts this narrow ladder for
// thinking models; the broader vendor-CLI ladders are not portable here.
export const OPENCODE_OLLAMA_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);
// Cursor Agent. MIRROR of `CURSOR_EFFORT_LEVELS`. Cursor takes NO `--effort`
// flag — the server folds the level into the model id as Cursor's own variant
// syntax (`gpt-5[effort=max]`) — but the level is still user-pickable, so this
// ladder drives the same selects as every other CLI's.
export const CURSOR_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** True when an OpenCode process provider is backed by the local Ollama daemon. */
export const isOpencodeOllamaProvider = (provider) =>
  (['opencode', 'opencode-tui'].includes(String(provider?.id || '').toLowerCase())
    || commandBasename(provider?.command) === 'opencode')
  && provider?.ollamaBacked === true;

/**
 * Antigravity base-model ↔ effort-suffix split — MIRROR of
 * `splitAntigravityModel` / `antigravityBaseModels` / `antigravityModelEffortLevels`
 * in server/lib/providerModels.js; keep in lockstep.
 *
 * `agy models` enumerates the effort tiers as separate model ids
 * (`gemini-3.6-flash-low|-medium|-high`), which forces the effort choice into
 * the model dropdown. agy also accepts the BASE id with a separate `--effort`
 * flag, so PortOS lists base models and carries effort as its own control. agy
 * validates the PAIR, though (`gemini-3.1-pro` has no `medium`), so the tiers a
 * base model offers come from the provider's own catalog.
 */
const ANTIGRAVITY_EFFORT_SUFFIX_RE = new RegExp(`-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`);

/**
 * `gemini-3.6-flash-high` → `{ base: 'gemini-3.6-flash', effort: 'high' }`.
 * Unsuffixed ids, sentinels and non-strings → `{ base: <input>, effort: null }`.
 * @param {string|null|undefined} id
 * @returns {{base: string|null|undefined, effort: string|null}}
 */
export const splitAntigravityModel = (id) => {
  if (typeof id !== 'string' || id === '' || isConfiguredDefaultModel(id)) return { base: id, effort: null };
  const match = ANTIGRAVITY_EFFORT_SUFFIX_RE.exec(id);
  return match ? { base: id.slice(0, -match[0].length), effort: match[1] } : { base: id, effort: null };
};

/**
 * The user-selectable view of an Antigravity model list: effort suffixes
 * stripped, duplicates collapsed, order preserved. Sentinels and non-string
 * (`{ id, name }`) entries ride through untouched.
 * @param {unknown[]} models
 * @returns {unknown[]}
 */
export const antigravityBaseModels = (models) => {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(models) ? models : []) {
    if (typeof entry !== 'string') { out.push(entry); continue; }
    const { base } = splitAntigravityModel(entry);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
};

/**
 * The effort tiers an Antigravity base model offers per the provider's catalog:
 * the present suffixes, `[]` when the model has none, or `null` when the MODEL
 * is unknown — blank, the configured-default sentinel, or an empty catalog — so
 * the caller falls back to the full ladder. The sentinel case matters: it is the
 * shipped agy `defaultModel`, and reporting `[]` for it would hide the effort
 * control on every freshly-opened picker.
 * @param {string|null|undefined} model
 * @param {unknown[]} models
 * @returns {readonly string[]|null}
 */
export const antigravityModelEffortLevels = (model, models) => {
  const list = (Array.isArray(models) ? models : []).filter(m => typeof m === 'string');
  if (list.length === 0) return null;
  if (isConfiguredDefaultModel(model)) return null;
  const { base } = splitAntigravityModel(model);
  if (typeof base !== 'string' || base === '') return null;
  return Object.freeze(ANTIGRAVITY_EFFORT_LEVELS.filter(level => list.includes(`${base}-${level}`)));
};

/**
 * The provider's selectable model list as the pickers should show it. Today that
 * only rewrites Antigravity (base models instead of one row per effort tier);
 * every other provider's list passes through untouched. The single place the
 * normalization lives, so `useProviderModels` and any caller that reads
 * `provider.models` directly agree.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @param {unknown[]} models
 * @returns {unknown[]}
 */
export const selectableModelsForProvider = (provider, models) =>
  isAntigravityProvider(provider) ? antigravityBaseModels(models) : (models || []);

/**
 * Keeps a stored-but-no-longer-listed Antigravity id visible as its own option.
 *
 * A record saved before Antigravity split model from effort still holds
 * `gemini-3.6-flash-high`, which matches no base-model option and would render
 * the select BLANK (reading as "no model"). The server splits such an id back
 * into base + `--effort`, so the pin still runs — it just has to stay selectable.
 * Same posture as `EffortSelect`'s out-of-ladder option.
 *
 * Deliberately narrow: only an Antigravity id carrying an effort SUFFIX
 * qualifies. A bare "not in the list" test would also re-surface the
 * configured-default sentinel (the shipped agy `defaultModel`, which
 * `filterSelectableModels` exists to hide) and any typo'd/stale pin.
 *
 * CLIENT-ONLY (no server mirror) — this is a rendering concern.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @param {unknown[]} models - the already-filtered option list
 * @param {string|null|undefined} selectedModel
 * @returns {unknown[]}
 */
export const withStaleAntigravityPin = (provider, models, selectedModel) => {
  const list = models || [];
  const stale = isAntigravityProvider(provider)
    && !!splitAntigravityModel(selectedModel).effort
    && !list.includes(selectedModel);
  return stale ? [...list, selectedModel] : list;
};

/**
 * The option list for a picker that renders an effort control but reads
 * `provider.models` directly (no `useProviderModels`): base models, sentinels
 * stripped, plus any legacy suffixed pin so the stored value stays visible.
 * The hook's own list is assembled from the same two primitives, so the two
 * paths can't drift.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} selectedModel
 * @returns {unknown[]}
 */
export const effortAwareModelOptions = (provider, selectedModel) => withStaleAntigravityPin(
  provider,
  filterSelectableModels(selectableModelsForProvider(provider, provider?.models)),
  selectedModel,
);

/**
 * The model a run will ACTUALLY use: the explicit pin, else the provider's own
 * default. A blank model isn't a no-op — the resolver falls through to
 * `defaultModel` — so anything keyed on the model (Antigravity's effort tiers,
 * the local tool-use warning) has to evaluate this, not the raw selection.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{defaultModel?:string}|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {string}
 */
export const effectiveModelFor = (provider, model) => model || provider?.defaultModel || '';

/**
 * Seeds a picker's two controls from a record that may predate the split.
 * `{ model: 'gemini-3.6-flash-high', effort: '' }` reads back as
 * `{ model: 'gemini-3.6-flash', effort: 'high' }`; a stored `effort` always
 * wins over the suffix, and a non-Antigravity provider is left alone so a model
 * that merely ends in `-high` isn't truncated.
 *
 * CLIENT-ONLY (no server mirror) — the server reads the suffixed id directly.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @returns {{model: string, effort: string}}
 */
export const seedModelEffort = (provider, model, effort) => {
  if (!isAntigravityProvider(provider)) return { model: model || '', effort: effort || '' };
  const { base, effort: bakedEffort } = splitAntigravityModel(model || '');
  return { model: base || '', effort: effort || bakedEffort || '' };
};

/**
 * The effort levels a provider's CLI accepts, or null when the provider has no
 * effort control (opencode, grok, kimi, HTTP API providers). Keyed on the launch
 * command basename plus the shipped provider ids, so path-configured or renamed
 * claude/codex/agy providers still qualify. Drives the "Effort (optional)"
 * select in task/schedule forms.
 *
 * `model` narrows the Antigravity ladder to the tiers that base model actually
 * offers (see above). Omit it — or leave `provider.models` empty — for the full
 * low/medium/high ladder. MIRROR of the server helper; keep in lockstep.
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model]
 * @returns {readonly string[]|null}
 */
export const effortLevelsForProvider = (provider, model = null) => {
  if (!provider) return null;
  if (isOpencodeOllamaProvider(provider)) return OPENCODE_OLLAMA_EFFORT_LEVELS;
  if (isCodexProvider(provider)) return CODEX_EFFORT_LEVELS;
  if (isAntigravityProvider(provider)) {
    const perModel = model ? antigravityModelEffortLevels(model, provider.models) : null;
    if (perModel === null) return ANTIGRAVITY_EFFORT_LEVELS;
    return perModel.length ? perModel : null;
  }
  if (isCursorProvider(provider)) return CURSOR_EFFORT_LEVELS;
  const id = String(provider.id || '').toLowerCase();
  if (id.startsWith('claude-code') || commandBasename(provider.command) === 'claude') return CLAUDE_EFFORT_LEVELS;
  return null;
};

/**
 * The effort a picker should keep after its MODEL changed under a fixed provider:
 * the current one, or `''` when the new model has no effort control at all.
 *
 * Antigravity's tiers are per-model, and a model with NO tiers hides the select
 * entirely (`effortLevelsForProvider` → null — `claude-sonnet-4-6` in the shipped
 * agy catalog has no `-low|-medium|-high` siblings). Without this the previous
 * effort stays in state with no UI left to clear it, and every submit path still
 * sends it: an invocation agy rejects (`--model claude-sonnet-4-6 --effort high`)
 * and, on the records that persist it, a stored level the run never used.
 *
 * A merely NARROWED ladder is deliberately left alone — `EffortSelect` renders an
 * explicit `medium (runs as low)` option there, so the clamp stays visible rather
 * than silently discarding the user's choice.
 *
 * CLIENT-ONLY (no server mirror) — the server clamps what it is sent; this keeps
 * the UI from sending something it stopped showing.
 * @param {{id?:string, command?:string, models?:unknown[], defaultModel?:string}|null|undefined} provider
 * @param {string|null|undefined} model - the NEWLY selected model
 * @param {string|null|undefined} effort - the currently selected effort
 * @returns {string}
 */
export const effortSurvivingModel = (provider, model, effort) =>
  (effortLevelsForProvider(provider, effectiveModelFor(provider, model)) ? (effort || '') : '');

// Every effort value any CLI accepts, weakest→strongest. MIRROR of EFFORT_RANK
// in server/lib/providerModels.js — keep in lockstep.
const EFFORT_RANK = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * The level a stored effort will ACTUALLY run at on this provider, or null when
 * no flag is emitted. MIRROR of `resolveCliEffort` in
 * server/lib/providerModels.js — keep in lockstep.
 *
 * The UI needs this because the server clamps an out-of-ladder effort rather
 * than dropping it: a stage pinned to claude `max` and switched to Antigravity
 * (whose ladder stops at `high`) still runs, at `high`. Without this the select
 * holds a value matching no option, renders blank — reading as "Default effort"
 * — while the run silently uses the clamped level.
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string|null}
 */
export const resolveCliEffort = (effort, provider, model = null) => {
  if (!effort) return null;
  const levels = effortLevelsForProvider(provider, model);
  if (!levels) return null;
  if (levels.includes(effort)) return effort;
  const requested = EFFORT_RANK.indexOf(effort);
  if (requested === -1) return null;
  const supported = levels.map(l => EFFORT_RANK.indexOf(l)).filter(i => i !== -1).sort((a, b) => a - b);
  if (supported.length === 0) return null;
  const below = supported.filter(i => i < requested);
  return EFFORT_RANK[below.length ? below[below.length - 1] : supported[0]];
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
  // Mirror of EMBEDDING_RE in server/lib/localModelHeuristics.js — keep in lockstep.
  // `embeddinggemma` needs its own alternative: the anchored `embedding` marker
  // requires a separator after it, and that id glues the family straight on.
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5|snowflake-arctic-embed)(?:[-_/:]|$)|text-embedding|embeddinggemma/i.test(id);

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
  /(?:^|[-_/:])vision(?:[-_/:.]|$)|(?:^|[-_/:])vl(?:\d|[-_/:.]|$)|qwen[\d.]*-?vl|(?:^|[-_/:])gemma-?[34]|llava|bakllava|moondream|minicpm-?v|pixtral|smolvlm|internvl|cogvlm|glm-?4v|phi-?3\.5?-vision|phi-?4-multimodal|got-ocr|idefics|fuyu|paligemma|kosmos|nanollava/i.test(id);

/**
 * Whether a CLI-type provider can read an image file (its CLI accepts a
 * vision attachment). Mirror of `isVisionCapableCliProvider` in
 * server/lib/localModelHeuristics.js — keyed on command basename so a
 * renamed/path-configured Claude or Codex still qualifies. API providers
 * return false here; use `visionLocalModelFilter` for their model lists.
 * @param {{type?:string, command?:string}|null|undefined} provider
 * @returns {boolean}
 */
export const isVisionCapableCliProvider = (provider) =>
  provider?.type === 'cli'
  && (commandBasename(provider.command) === 'codex' || commandBasename(provider.command) === 'claude');

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
  /qwen|llama-?3\.[1-9]|llama-?4|mistral|mixtral|ministral|codestral|devstral|magistral|command-?r|command-?a|north-mini-code|firefunction|functionary|watt-tool|hermes|functiongemma|glm-?4|granite-?[34]|(?:^|[-_/:])gemma-?4|gpt-oss|nemotron|olmo-?3|lfm2|ornith|muse-glimmer|nex-n2|smollm2|dflash|deepseek-v3|deepseek-r1|deepseek-v4/i.test(id);

/**
 * Agent-picker tool-use annotation for a model id. Agent / CoS tasks (the CD
 * treatment + plan stages, coding agents) only work with a model that can emit
 * native tool calls — a local model that can't (e.g. Gemma) narrates a
 * done-message instead of acting, silently wedging the task. This decides the
 * per-option marker + the "pick a tool-capable model" warning in agent pickers.
 *
 * Tool-use is surfaced as an ANNOTATION + warning, never as a filter: the
 * heuristic is a positive allowlist, so a non-match is "not a recognized
 * tool-caller", not a proven negative, and hiding those options would make a
 * newer tool-capable family unselectable (see {@link withToolUseOptionLabel}).
 *
 * Returns `null` for cloud / API providers: their model ids don't encode their
 * family, so the name heuristic would mislabel them. LOCAL backends return
 * `{ toolCapable }` — where "local" is BOTH a direct Ollama / LM Studio backend
 * ({@link localBackendForProvider}) AND an Ollama-BACKED CLI/TUI wrapper
 * ({@link isOllamaBackedProvider}): a renamed `claude-ollama-tui` / OpenCode
 * wrapper keeps `ollamaBacked: true` but may lose the "ollama"
 * name/endpoint/id that `localBackendForProvider` matches on, and that wrapper
 * is exactly the incident's provider class — so it must still be flagged, not
 * silently skipped.
 *
 * `toolUseIdsByProvider` is the AUTHORITATIVE map the server reports from each
 * backend's own capability metadata (Ollama `/api/show` `tools`) keyed by the
 * PROVIDER ID the server says serves each model — see `useToolUseModelIds`. It
 * is UNIONED with, never substituted for, {@link isToolUseModel}: the regex is a
 * positive allowlist that goes stale every time a new function-calling family
 * ships (`phi4-mini`, newer Gemma builds got "⚠ no known tool use" while the
 * Local LLMs tab's "Agents" badge, reading these same capabilities, said
 * otherwise), while the map can't speak for a provider the server never
 * enumerated. Pass `null` (the default) when it hasn't loaded — that degrades to
 * regex-only, the behavior this picker has always had.
 *
 * Keyed by the ENUMERATED PROVIDER, not flattened and not keyed by backend,
 * because a bare id is not a capability: a CUSTOM provider (or an Ollama-backed
 * CLI wrapper) pointed at a *different* Ollama/LM Studio host resolves to the
 * same backend, but the server never enumerated that host — so a local model's
 * id must not vouch for a remote model that merely shares its name. Such a
 * provider stays regex-only, which is the conservative direction: a false
 * "tool-capable" sends an agent to a model that narrates instead of acting.
 * @param {string} id
 * @param {object} [provider]
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider]
 * @returns {{toolCapable:boolean}|null}
 */
export const localToolUseHint = (id, provider, toolUseIdsByProvider = null) =>
  (localBackendForProvider(provider) || isOllamaBackedProvider(provider) || provider?.mtplxBacked === true || provider?.llamaBacked === true)
    && typeof id === 'string' && id.length > 0
    ? { toolCapable: toolUseIdsByProvider?.[provider?.id]?.has(id) === true || isToolUseModel(id) }
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
 * false-certain "no tool use". Passing `toolUseIdsByProvider` (from
 * `useToolUseModelIds`) shrinks that unverified band to the models the server
 * couldn't speak for; see {@link localToolUseHint} for the union rule.
 * @param {string} id - model id (drives the heuristic)
 * @param {string} label - display label to annotate (often === id)
 * @param {object} [provider] - the selected provider object
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider] - authoritative
 *   server-reported tool-capable ids, keyed by provider id; `null` = regex-only
 * @returns {string}
 */
export const withToolUseOptionLabel = (id, label, provider, toolUseIdsByProvider = null) => {
  const hint = localToolUseHint(id, provider, toolUseIdsByProvider);
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
 *
 * Client mirror of `localBackendForProvider` in
 * server/lib/localProviderRuntime.js — keep in lockstep. The SERVER copy is
 * authoritative and stricter: it parses the endpoint as a URL and requires a
 * loopback/bind-all host, so a peer machine's daemon on the same port is not
 * claimed as local. This one only labels UI, so it stays a cheap regex; if it
 * ever gates an action, take the server's rules with it.
 *
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

// The whole loopback block (`127.0.0.0/8`), not just `127.0.0.1` — a daemon on a
// loopback alias (`127.0.0.2`) is as local as one on `.1`, and the server's
// `isLocalInstanceHost` already accepts the full block. While they disagreed, a
// provider on `http://127.0.0.2:11434` was badged NEEDS SETUP for an API key a
// loopback endpoint never needs.
const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?|\[?::\]?)(:|\/|$)/i;
export const isLocalEndpoint = (endpoint) =>
  typeof endpoint === 'string' && LOCAL_ENDPOINT_RE.test(endpoint.trim());

// Hosts inside the trust boundary, where an unauthenticated OpenAI-compatible
// server is a normal setup rather than a misconfiguration: RFC1918 LAN ranges,
// link-local, and the Tailscale CGNAT range 100.64.0.0/10 (PortOS is a
// tailnet-first product — an API provider pointed at another machine's Ollama
// is a first-class configuration, not an edge case).
const PRIVATE_IP_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * IPv6 counterpart to {@link PRIVATE_IP_RE}: unique-local (`fc00::/7`) and
 * link-local (`fe80::/10`). Tailscale hands out a ULA address alongside the
 * CGNAT v4 one, so without this a tailnet peer reached over IPv6 read as a
 * public host and its keyless provider was blocked on a missing API key.
 *
 * Gated on the host being an IPv6 literal (it contains a `:`) and compared
 * NUMERICALLY on the leading hextet — a bare `/^f[cd]/` prefix test would also
 * claim hostnames like `fdrive.example.com`, and `fd::1` expands to a leading
 * hextet of `0x00fd`, which is not in `fc00::/7` at all.
 */
const isPrivateIpv6 = (host) => {
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false; // '' for `::1` — loopback, already matched above
  const n = parseInt(first, 16);
  return (n >= 0xfc00 && n <= 0xfdff) || (n >= 0xfe80 && n <= 0xfebf);
};

/**
 * Is this endpoint inside the private network — loopback, a LAN/tailnet address,
 * a `.local`/`.ts.net`/`.internal` name, or a bare single-label host?
 *
 * Used to decide whether a missing API key is actually a missing prerequisite.
 * The server only attaches an `Authorization` header when a key is stored, so a
 * keyless call to a private OpenAI-compatible server (LM Studio on the desk
 * machine, Ollama on a tailnet peer) works exactly as configured — reporting it
 * as "needs setup" would be a false alarm on a supported deployment. A public
 * endpoint with no key stays flagged: that one really is misconfigured.
 *
 * A host that cannot be parsed reads as NOT private, keeping the stricter of
 * the two answers for input we don't understand.
 */
export const isPrivateNetworkEndpoint = (endpoint) => {
  if (isLocalEndpoint(endpoint)) return true;
  if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
  const trimmed = endpoint.trim();
  // A scheme-less endpoint ("192.168.1.5:1234/v1") is still a host — give the
  // parser one so it doesn't read the leading segment as a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return false;
  const host = new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_IP_RE.test(host)) return true;
  if (isPrivateIpv6(host)) return true;
  if (/\.(local|internal|lan|home\.arpa|ts\.net)$/.test(host)) return true;
  // A single-label host resolves only inside the local network (`http://nas:11434`).
  return !host.includes('.') && !host.includes(':');
};

/**
 * Does this provider talk to a daemon on THIS machine?
 *
 * Client mirror of `isLocalInstanceEndpoint` in
 * server/lib/localProviderRuntime.js, and the guard for anything that explains
 * a provider by inspecting the machine PortOS runs on — "is `lms` installed
 * here?", "start it from Settings → Local LLM". A provider named for LM Studio
 * but pointed at another box on the tailnet matches
 * {@link localBackendForProvider} by NAME, so without this it collected this
 * machine's install state and offered to start a server it does not own.
 *
 * A blank endpoint reads as local, unlike the server's copy: the record simply
 * hasn't named one, and every default it can fall back to is a loopback URL.
 *
 * @param {{endpoint?:string}} provider
 * @returns {boolean}
 */
export const isLocalInstanceProvider = (provider) => {
  const endpoint = provider?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return true;
  return isLocalEndpoint(endpoint);
};

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
 * Base name of a spawn command, normalized the way the CoS Agent Runner's
 * allowlist check does before its membership test: strip any directory
 * prefix, then a trailing Windows `.exe`. Mirror of `isAllowedCommand`'s
 * normalization in `server/cos-runner/allowedCommands.js`, pinned by
 * `server/cos-runner/allowedCommands.parity.test.js`.
 *
 * The server uses `path.basename`, which is platform-specific — on a POSIX
 * host a backslash is NOT a separator. This mirror always treats both `/` and
 * `\` as separators, so a Windows-style path typed into the editor on a POSIX
 * install reads as "allowed" when the server would spawn-time reject it. That
 * direction is deliberate: this drives an informational warning, and a false
 * *warning* about a path the user's own platform handles fine is worse than a
 * missing one for a path shape that platform can't run anyway.
 */
const runnerCommandBaseName = (command) => {
  const base = String(command).replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  // Only `.exe` — a `.cmd`/`.bat` npm shim is deliberately NOT stripped,
  // matching the server: the spawn path runs with `shell: false` and cannot
  // execute a batch shim, so accepting it would only move the failure later.
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
};

/**
 * Would the CoS Agent Runner (`/spawn`, `/spawn-tui`) accept this command?
 *
 * `allowedCommands` is the server-published list (`runnerAllowedCommands` on
 * `GET /api/providers`) — the client never carries its own copy, because the
 * allowlist is the runner's exec boundary and must stay hand-curated
 * server-side rather than derived from user-writable provider config.
 *
 * Returns `null` for "can't tell" — the list hasn't been fetched, or the field
 * is still blank — which is distinct from `false` ("fetched, and this command
 * is definitely off the list"). Only an explicit `false` should render a
 * warning; a failed fetch must not accuse a perfectly good command.
 *
 * The command is matched UNTRIMMED (past the blank guard), because the editor
 * persists it untrimmed too — `'claude '` really would fail the runner's check.
 */
export const isRunnerAllowedCommand = (command, allowedCommands) => {
  if (!Array.isArray(allowedCommands) || allowedCommands.length === 0) return null;
  if (typeof command !== 'string' || command.trim() === '') return null;
  return allowedCommands.includes(runnerCommandBaseName(command));
};

/**
 * The key a CLI/TUI provider's runtime is published under in the `runtimes` map
 * from `GET /api/providers/runtimes` — the binary it spawns, basename-normalized
 * so a provider pinned to an absolute path still matches.
 *
 * Deliberately NOT a client-side copy of the runtime table: the server owns
 * which runtimes exist and how they install, and a key with no entry in the
 * fetched map simply renders no install widget. That's the right default for a
 * custom command PortOS has no installer for.
 *
 * API providers have no runtime here — the two fronted by a local app resolve
 * through `localBackendForProvider` (which also matches a renamed provider by
 * its endpoint) and get their install state from the local-LLM status.
 */
export const providerRuntimeKey = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const command = provider?.command;
  if (typeof command !== 'string' || command.trim() === '') return null;
  return runnerCommandBaseName(command.trim());
};

/**
 * Whether `provider` is served by an Ollama daemon rather than its nominal
 * cloud/CLI backend: the built-in `ollama` API provider itself (id match), an
 * `api`-type provider whose `endpoint` points at Ollama, or the Claude-Ollama
 * CLI/TUI pattern — a `claude` process carrying the `ollamaBacked` marker or an
 * `ANTHROPIC_BASE_URL` pointed at Ollama, which runs the Claude Code harness but
 * generates tokens locally, so its model list is refreshed from Ollama
 * (including the TUI variant, which the server refreshes via the
 * `type==='tui' && ollamaBacked` branch). MIRROR of `isOllamaBackedProvider` in
 * server/lib/aiToolkit/providers.js.
 * @param {{id?:string,endpoint?:string,ollamaBacked?:boolean,envVars?:Record<string,string>}} provider
 */
export const isOllamaBackedProvider = (provider) => {
  if (provider?.id === 'ollama') return true;
  if (provider?.ollamaBacked === true) return true;
  const base = String(provider?.envVars?.ANTHROPIC_BASE_URL || provider?.endpoint || '');
  return /:11434\b/.test(base) || /ollama/i.test(base);
};

/**
* True when a provider is an OpenCode wrapper that front-ends the OrcaRouter
* gateway (the shipped `opencode-orcarouter` / `opencode-orcarouter-tui`
* presets, or any renamed wrapper carrying the `orcarouterBacked` marker).
*
* These wrappers deliberately carry NO key of their own: at spawn time the
* server attaches the key from the sibling `orcarouter` API provider
* (`server/lib/aiToolkit/providers.js` `withOrcaRouterApiKey`), so the one place
* a user actually pastes the key is the `orcarouter` API provider, not this
* form. MIRROR of the `orcarouterBacked` marker the server keys on — keep in
* lockstep with `server/lib/providerModels.js#getOpencodeLocalProviderNamespace`.
* @param {{id?:string,orcarouterBacked?:boolean}} provider
*/
export const isOrcaRouterBackedProvider = (provider) => provider?.orcarouterBacked === true;

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
 * The four states a provider card can be in on the AI Providers page, ordered
 * the way the page groups them: usable now, temporarily benched, missing a
 * prerequisite, or simply switched off.
 */
export const PROVIDER_CARD_STATE = Object.freeze({
  READY: 'ready',
  BENCHED: 'benched',
  BLOCKED: 'blocked',
  DISABLED: 'disabled',
});

/**
 * Which prerequisites a provider is missing, and the card state that follows
 * from them — one place, so a card's border, its badge and the section the page
 * files it under can never disagree with each other.
 *
 * NOT the same thing as `ProviderReadiness` /
 * `GET /api/providers/readiness`, which probes whether the local DAEMON a
 * provider points at (llama.cpp, Ollama, LM Studio, MTPLX) is up and serving
 * the right model. This decides the card's bucket from its toggle, its
 * credentials and the server's bench status; the two render side by side.
 *
 * The prerequisite half is the SERVER's answer now (#4611): `GET
 * /api/providers` publishes `missingPrerequisites` per provider from
 * server/lib/providerPrerequisites.js, and `getFallbackProvider` skips a
 * provider whose CLI that same computation found missing — so a card blocked on
 * an uninstalled binary is no longer a routing candidate that dies at spawn
 * time on a raw ENOENT. (Routing acts only on that finding; a missing stored
 * key still shows here but stays presentation-only, because a provider can
 * authenticate through a secret env var — issue #4612, which also covers
 * DETECTING those env-var credentials so this stops over-reporting them.)
 *
 * This function consumes the published list and adds only what the browser
 * alone can see (the local-app runtime shape below). With an older server
 * publishing nothing, it falls back to deriving the credential checks itself.
 *
 * Inputs are passed in rather than read from globals so this stays pure:
 *   runtime          — the provider's entry of the `runtimes` map (CLI binary)
 *                      or the local-app shape the page derives from the
 *                      local-LLM status. `null` = NOT PROBED, which must never
 *                      read as "missing" (an older server, or a card drawn
 *                      before the probe lands, would otherwise accuse every
 *                      perfectly-installed CLI).
 *   status           — the runtime-availability entry from
 *                      `GET /api/providers/status`; `available === false`
 *                      means the provider is benched after a failure.
 *   orcaRouterKeySet — whether the sibling `orcarouter` API provider holds the
 *                      key an OpenCode OrcaRouter wrapper inherits at spawn
 *                      time. `false` covers BOTH "sibling has no key" and
 *                      "sibling was deleted" — the server injects the key only
 *                      when that provider exists and holds one, so either way
 *                      the wrapper cannot authenticate. `null` is for a caller
 *                      that genuinely cannot tell (no provider list yet) and,
 *                      like `runtime`, is never reported as missing.
 *
 * `blocked` outranks `disabled`: a provider whose CLI isn't installed can't be
 * enabled at all, so it belongs in the "needs setup" bucket whichever way its
 * toggle happens to sit. `benched` only applies to an enabled provider that
 * otherwise meets its prerequisites.
 *
 * @returns {{state: string, missing: {code: string, label: string}[]}}
 */
export const providerCardState = (provider, { runtime = null, status = null, orcaRouterKeySet = null } = {}) => {
  // The server publishes its own verdict on `GET /api/providers`
  // (`missingPrerequisites`, from server/lib/providerPrerequisites.js) and
  // routes the fallback chain on exactly that computation. Where it has an
  // answer it WINS, so the card and the router cannot drift.
  //
  // An ARRAY is the sentinel for "published" — including the empty array, which
  // is a real answer ("nothing missing"). Anything else (an older server, a
  // payload fetched before the field existed) means not published, and the
  // local derivation below stands in.
  const published = Array.isArray(provider?.missingPrerequisites) ? provider.missingPrerequisites : null;
  const missing = published ? [...published] : [];
  const addMissing = (code, label) => {
    if (!missing.some((entry) => entry?.code === code)) missing.push({ code, label });
  };

  // Kept client-side even when the server has published: `runtime` here may be
  // the LOCAL-APP shape the page derives from the local-LLM status (an LM Studio
  // / Ollama app installed with no CLI shim on PATH), which the server's runtime
  // table does not cover. For a plain CLI provider this is the same row the
  // server probed, and `addMissing` de-dupes it by code.
  if (runtime && runtime.installed === false) {
    addMissing('runtime', `${runtime.label || 'Runtime'} is not installed`);
  }
  if (!published) {
    // API providers auth solely via the stored key — but only an endpoint outside
    // the private network actually needs one. The server attaches `Authorization`
    // only when a key is stored, so a keyless call to loopback, a LAN box, or a
    // tailnet peer running LM Studio / Ollama works exactly as configured.
    if (isApiProvider(provider) && provider?.hasApiKey !== true && !isPrivateNetworkEndpoint(provider?.endpoint)) {
      addMissing('apiKey', 'API key is not set');
    }
    // The OpenCode OrcaRouter wrappers carry no key of their own — theirs lives
    // on the sibling API provider, so that's the prerequisite to report.
    if (isOrcaRouterBackedProvider(provider) && orcaRouterKeySet === false) {
      addMissing('inheritedApiKey', 'OrcaRouter API provider has no API key');
    }
  }

  if (missing.length > 0) return { state: PROVIDER_CARD_STATE.BLOCKED, missing };
  if (!provider?.enabled) return { state: PROVIDER_CARD_STATE.DISABLED, missing };
  if (status?.available === false) return { state: PROVIDER_CARD_STATE.BENCHED, missing };
  return { state: PROVIDER_CARD_STATE.READY, missing };
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
 * The provider a record will ACTUALLY run on: its own pin when set, else the
 * install's active provider. Every picker that offers a "use the default"
 * option needs this — the model list, effort ladder, and "Default (active: X)"
 * label all have to resolve against the fallback, or leaving a record unpinned
 * silently means "no model or effort can be picked either".
 *
 * `usingActive` distinguishes the two so a caller can say which provider the
 * blank option currently means rather than just showing "Default".
 *
 * @param {Array} providers
 * @param {string|null|undefined} pinnedId - The record's own provider pin.
 * @param {string|null|undefined} activeProviderId - The install's active provider.
 * @returns {{provider: object|undefined, usingActive: boolean}}
 */
export const resolveEffectiveProvider = (providers, pinnedId, activeProviderId) => {
  const id = pinnedId || activeProviderId || '';
  const provider = id ? (providers || []).find((p) => p.id === id) : undefined;
  return { provider, usingActive: !pinnedId && !!provider };
};

/**
 * Effective provider/model for a run against a Pipeline series — CLIENT MIRROR
 * of `resolveSeriesLlmOverride` (server/lib/seriesLlmOverride.js; the precedence
 * rationale lives there), extended with the install's active provider as the
 * final fallback so the UI can NAME what a run will call instead of a blank.
 *
 * Used by the Autopilot Options picker and the scheduled-run consent card so
 * both name the same thing the server's `resolveAutopilotLlm` will resolve.
 *
 * @returns {{provider: string, model: string}}
 */
export const resolveSeriesRunLlm = (series, { overrideProvider, overrideModel, activeProviderId } = {}) => {
  const seriesProvider = series?.llm?.provider || '';
  // The series model belongs to the series provider — an override naming a
  // different provider must resolve THAT provider's default instead.
  const inheritsSeriesModel = !overrideProvider || overrideProvider === seriesProvider;
  return {
    provider: overrideProvider || seriesProvider || activeProviderId || '',
    model: overrideModel || (inheritsSeriesModel ? series?.llm?.model || '' : ''),
  };
};

/**
 * "Claude Code / claude-opus-5" — or "Claude Code (provider default model)"
 * when no model is pinned. The one phrasing for "which AI will this run call",
 * so the Autopilot Options copy, its live-progress line and the scheduled-run
 * consent card can't word the same fact three different ways.
 */
export const providerModelLabel = (providers, id, model) =>
  `${providerDisplayName(providers, id, '—')}${model ? ` / ${model}` : ' (provider default model)'}`;

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
 * Tool-use annotation state for one AI-assignment row/stage, so every editor of
 * the same pin (the AI Assignments table, the Creative Director Models drawer,
 * any future one) derives it identically instead of re-deriving the rule and
 * drifting — the drawer used to be the only editor that warned at all, because
 * its stage list hard-coded `needsTools` client-side.
 *
 * `entry.needsTools` is the SERVER's marker for an assignment whose provider runs
 * an agent harness (see `agentEntry` in server/services/aiAssignments.js). It
 * mirrors `modelFilter: 'vision'`: one server flag, read uniformly.
 *
 * Three rules are baked in here so a caller can't forget one:
 *   - The EFFECTIVE model is judged, not the pin. A blank model isn't a no-op —
 *     the agent resolver then runs the provider's own `defaultModel`, which for a
 *     local backend can be the non-tool model that wedges the run.
 *   - Nothing is asserted until the capability scan SETTLES (`toolUseLoaded`,
 *     success or failure). Annotating mid-scan shows the false "no known tool
 *     use" the authoritative union exists to remove, only to retract it a beat
 *     later.
 *   - `incapable` is a strict `=== false` on the hint, so a non-agent entry, a
 *     cloud provider (`localToolUseHint` returns null — ids don't encode family)
 *     or an unpinned row all read as "no warning", never as "incapable".
 *
 * @param {{needsTools?:boolean}|null|undefined} entry - the assignment entry
 * @param {object|undefined} provider - the currently selected provider object
 * @param {string} model - the row's model pin ('' = provider default)
 * @param {Record<string, Set<string>>|null} [toolUseIdsByProvider] - from `useToolUseModelIds`
 * @param {boolean} [toolUseLoaded] - whether that scan has settled
 * @returns {{annotate: boolean, effectiveModel: string, incapable: boolean}}
 */
export const assignmentToolUseState = (entry, provider, model, toolUseIdsByProvider = null, toolUseLoaded = false) => {
  const effectiveModel = effectiveModelFor(provider, model);
  const annotate = entry?.needsTools === true && toolUseLoaded;
  const hint = annotate ? localToolUseHint(effectiveModel, provider, toolUseIdsByProvider) : null;
  return { annotate, effectiveModel, incapable: hint?.toolCapable === false };
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
