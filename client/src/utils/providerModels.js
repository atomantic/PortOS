/**
 * Which MODEL and EFFORT a provider actually runs, and what a picker may offer:
 * the "use the CLI's own default" sentinels, the per-CLI reasoning-effort
 * ladders and the clamp a stored effort resolves through, the Antigravity
 * base-model ↔ effort-suffix split, the account-aware option list for a
 * Codex-subscription provider, the model-list merge used when a refresh lands,
 * and which generation controls (temperature / top-p / thinking) a provider
 * forwards at all.
 *
 * Browser MIRROR of `server/lib/providerModels.js` (sentinels, effort ladders,
 * `EFFORT_RANK`, the Antigravity split, `resolveCliEffort`) and of the
 * generation-control tables in `server/lib/opencodeConfig.js` /
 * `server/lib/aiToolkit/internal/generationOptions.js`.
 * `server/lib/providerModels.mirror.test.js` reads this file as TEXT and fails
 * when a mirrored declaration drifts. Helpers marked CLIENT-ONLY are rendering
 * concerns with no server twin.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isGatewayBackedProvider } from './providerGateways.js';
import { commandBasename, isAntigravityProvider, isClaudeCommandProvider, isCodexProvider, isCodexSubscriptionProvider, isCursorProvider, isGrokProvider, isOllamaBackedProvider, isOpencodeLocalProvider } from './providerTypes.js';

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
 * `none|minimal|low|medium|high|xhigh`. Sol and Terra additionally advertise
 * `ultra`, which adds automatic task delegation; older models and Luna top out
 * at `max`.
 */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const CODEX_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const CODEX_ULTRA_EFFORT_LEVELS = Object.freeze([...CODEX_EFFORT_LEVELS, 'ultra']);

export const ANTIGRAVITY_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

// OpenCode passes this through as `reasoningEffort` to its configured local
// provider. The OpenAI-compatible local backends accept this narrow ladder for
// thinking models; the broader vendor-CLI ladders are not portable here.
export const OPENCODE_LOCAL_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high']);

// Cursor Agent. MIRROR of `CURSOR_EFFORT_LEVELS`. Cursor takes NO `--effort`
// flag — the server folds the level into the model id as Cursor's own variant
// syntax (`gpt-5[effort=max]`) — but the level is still user-pickable, so this
// ladder drives the same selects as every other CLI's.
export const CURSOR_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Grok Build CLI. MIRROR of `GROK_EFFORT_LEVELS` in server/lib/providerModels.js.
// Grok's own ladder, read off its rejection message rather than guessed
// (`use one of: xhigh, high, medium, low`) — no `max`/`minimal`, so a stored
// `max` clamps to `xhigh` here exactly as it does on the server.
export const GROK_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

const CODEX_ULTRA_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra']);

const codexEffortLevelsForModel = (model) => CODEX_ULTRA_MODELS.has(String(model || '').trim().toLowerCase())
  ? CODEX_ULTRA_EFFORT_LEVELS
  : CODEX_EFFORT_LEVELS;

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
 * The model ids in a signed-in ChatGPT account's catalog, or `null` when the
 * catalog is not a SUCCESSFUL read.
 *
 * The server ships `{ models, fetchedAt, error }` on a Codex-subscription
 * provider (`codexModelCatalog`), and all three states are distinct:
 * `models: null` = never fetched, a set `error` = the last read failed (the
 * list, if any, is only last-known-good), and `[]` = this account genuinely
 * exposes no models. Only the last two of those are answers about the account,
 * so a never-fetched or failed read collapses to `null` here and the caller
 * keeps its shipped list — an offline or signed-out user must never be handed
 * an empty dropdown.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{codexModelCatalog?:{models?:unknown, error?:unknown}}|null|undefined} provider
 * @returns {string[]|null}
 */
export const codexCatalogModelIds = (provider) => {
  if (!isCodexSubscriptionProvider(provider)) return null;
  const catalog = provider?.codexModelCatalog;
  if (!catalog || catalog.error || !Array.isArray(catalog.models)) return null;
  return catalog.models
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id !== '');
};

/**
 * The RAW model list a picker should read for a provider, before any
 * sentinel/effort/hardware filtering: the signed-in ChatGPT account's own
 * catalog when one has been fetched, otherwise the provider's configured
 * `models` — falling back to its `defaultModel` when that list is empty (a
 * cloud/manual provider configured with only a default; `[]` is truthy, so a
 * bare `||` would leave such a picker empty).
 *
 * This is the single place the account catalog enters a picker, so a caller
 * that reads `provider.models` directly is the one bug this exists to prevent
 * (#6306). A successfully-read EMPTY catalog is returned as `[]` and must not
 * fall through to `defaultModel`: the account really has no models, and
 * offering its default would put back the un-runnable option.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{models?:unknown[], defaultModel?:string}|null|undefined} provider
 * @returns {unknown[]}
 */
export const providerModelList = (provider) => {
  const catalog = codexCatalogModelIds(provider);
  if (catalog) return catalog;
  return provider?.models?.length ? provider.models : [provider?.defaultModel];
};

/** Where a picker's option list came from. */
export const MODEL_SOURCE = Object.freeze({
  /** The provider's shipped/configured `models` array. */
  shipped: 'shipped',
  /** The signed-in ChatGPT account's own catalog. */
  account: 'account',
  /** The account was read successfully and exposes no models. */
  accountEmpty: 'account-empty',
});

/**
 * The option list for a picker, plus WHERE it came from.
 *
 * For a Codex-subscription provider whose account catalog has been fetched, the
 * options are that account's real models — so a tier the plan cannot run is not
 * selectable and cannot be queued against a worktree that would only fail later.
 * Every other state (never fetched, failed read, non-Codex provider) falls back
 * to the shipped list unchanged.
 *
 * ADDITIVE: a stored `selectedModel` the catalog no longer lists is retained as
 * its own option and reported via `unlistedSelection`, so an existing task
 * template renders what it actually holds instead of silently changing model.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} selectedModel
 * @returns {{models: unknown[], source: string, unlistedSelection: boolean}}
 */
export const resolveProviderModelOptions = (provider, selectedModel) => {
  const shipped = withStaleAntigravityPin(
    provider,
    filterSelectableModels(selectableModelsForProvider(provider, provider?.models)),
    selectedModel,
  );
  const catalog = codexCatalogModelIds(provider);
  if (!catalog) return { models: shipped, source: MODEL_SOURCE.shipped, unlistedSelection: false };
  const models = filterSelectableModels(catalog);
  const unlistedSelection = !!selectedModel
    && !isConfiguredDefaultModel(selectedModel)
    && !models.includes(selectedModel);
  return {
    models: unlistedSelection ? [...models, selectedModel] : models,
    source: models.length > 0 ? MODEL_SOURCE.account : MODEL_SOURCE.accountEmpty,
    unlistedSelection,
  };
};

/**
 * The option list for a picker that renders an effort control but reads
 * `provider.models` directly (no `useProviderModels`): base models, sentinels
 * stripped, plus any legacy suffixed pin so the stored value stays visible.
 * The hook's own list is assembled from the same two primitives, so the two
 * paths can't drift. Codex-subscription providers resolve through
 * `resolveProviderModelOptions`, so every picker offers the same account-aware
 * answer without each one reimplementing the fallback.
 *
 * CLIENT-ONLY (no server mirror).
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} selectedModel
 * @returns {unknown[]}
 */
export const effortAwareModelOptions = (provider, selectedModel) =>
  resolveProviderModelOptions(provider, selectedModel).models;

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
  if (isOpencodeLocalProvider(provider)) return OPENCODE_LOCAL_EFFORT_LEVELS;
  if (isCodexProvider(provider)) return codexEffortLevelsForModel(model);
  if (isAntigravityProvider(provider)) {
    const perModel = model ? antigravityModelEffortLevels(model, provider.models) : null;
    if (perModel === null) return ANTIGRAVITY_EFFORT_LEVELS;
    return perModel.length ? perModel : null;
  }
  if (isCursorProvider(provider)) return CURSOR_EFFORT_LEVELS;
  if (commandBasename(provider.command) === 'pi') return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (isGrokProvider(provider)) return GROK_EFFORT_LEVELS;
  const id = String(provider.id || '').toLowerCase();
  if (id.startsWith('claude-code') || commandBasename(provider.command) === 'claude') return CLAUDE_EFFORT_LEVELS;
  // Sanitized provider inventories intentionally omit command/path/env details.
  // The server publishes the derived ladder so renamed custom CLIs still expose
  // the same effort control without leaking machine-specific configuration.
  const modelLevels = model ? provider.effortLevelsByModel?.[model] : null;
  if (Array.isArray(modelLevels)) return modelLevels.length ? modelLevels : null;
  if (Array.isArray(provider.effortLevels)) return provider.effortLevels.length ? provider.effortLevels : null;
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
 * Merge a partial-update payload onto an existing provider record in place, so
 * repointing a provider at a new backend (e.g. a fleet host) doesn't clobber
 * fields the payload didn't set out to change. A raw PATCH replaces whichever
 * top-level keys it names wholesale — without this, pointing an OpenCode TUI
 * provider at a new endpoint would silently drop its other env vars and reset
 * its served-model history to just the one new model id.
 *
 * @param {object|null|undefined} target - the existing provider being updated
 * @param {object} payload - field values about to be written; mutated in place
 * @returns {object} payload
 */
export const mergeProviderUpdate = (target, payload) => {
  if (!target) return payload;
  if (payload.envVars) payload.envVars = { ...target.envVars, ...payload.envVars };
  if (payload.secretEnvVars) {
    payload.secretEnvVars = Array.from(new Set([...(target.secretEnvVars || []), ...payload.secretEnvVars]));
  }
  if (payload.models) payload.models = mergeModelLists(target.models, payload.models);
  return payload;
};

/**
 * Which default generation controls the provider editor should offer, or null
 * when the provider has none.
 *
 * Only the local OpenAI-compatible backends qualify — Ollama, llama.cpp, MTPLX
 * and vLLM (the first three reached directly as an `api` provider or through an
 * OpenCode CLI/TUI wrapper; vLLM ships only the wrappers), plus the hosted
 * gateways (OrcaRouter, OpenRouter). A hosted cloud provider is deliberately excluded: PortOS sends it no
 * sampling fields at all, so offering a stored temperature there would be a
 * control that silently does nothing.
 *
 * Each control is reported separately because the forwarding is uneven:
 * A gateway's upstream models own their own reasoning switch, so it has no
 * thinking toggle; and the Claude Code harness pointed at Ollama takes ONLY a
 * thinking signal (`MAX_THINKING_TOKENS=0` in server/lib/cliChildEnv.js) — it
 * owns its own sampling, so a temperature or top-p stored on one of those
 * records would never reach the daemon. MIRROR of `THINKING_STYLE` /
 * `buildAgentGeneration` in server/lib/opencodeConfig.js and
 * `apiGenerationOptions` in server/lib/aiToolkit/internal/generationOptions.js;
 * keep in lockstep.
 * @param {object|null|undefined} provider
 * @returns {{temperature:boolean, topP:boolean, thinking:boolean}|null}
 */
export const generationControlsFor = (provider) => {
  const gateway = isGatewayBackedProvider(provider);
  // LM Studio forwards temperature/top_p like any OpenAI-compatible endpoint,
  // but reasoning there belongs to the LOADED model instance — see
  // THINKING_STYLE.lmstudio on the server, which resolves to no toggle.
  const lmstudio = provider?.lmstudioBacked === true;
  const local = isOllamaBackedProvider(provider)
    || lmstudio
    || provider?.llamaBacked === true
    || provider?.mtplxBacked === true
    || provider?.vllmBacked === true
    // SGLang takes the same `chat_template_kwargs.enable_thinking` as the other
    // local OpenAI endpoints — see THINKING_STYLE.sglang on the server.
    || provider?.sglangBacked === true;
  if (!local && !gateway) return null;
  if (isClaudeCommandProvider(provider)) {
    // A Claude harness owns its own sampling, so only the thinking signal is
    // ever forwardable — and only on Ollama, whose Anthropic endpoint maps an
    // omitted `thinking` field to non-thinking mode (`MAX_THINKING_TOKENS=0`
    // in server/lib/cliChildEnv.js). Every other local backend takes
    // `chat_template_kwargs.enable_thinking`, which the Anthropic wire cannot
    // carry — on SGLang the omitted field falls through to Qwen3.8's
    // chat-template default (thinking ON), so offering the toggle there would
    // pin a value nothing reads. No control at all is the honest answer.
    return isOllamaBackedProvider(provider)
      ? { temperature: false, topP: false, thinking: true }
      : null;
  }
  // LM Studio joins the gateways in having no forwardable thinking signal.
  return { temperature: true, topP: true, thinking: !gateway && !lmstudio };
};
