/**
 * Which MODEL and EFFORT a provider actually runs, and what a picker may offer:
 * the "use the CLI's own default" sentinels, the per-CLI reasoning-effort
 * ladders and the clamp a stored effort resolves through, the Antigravity
 * base-model ↔ effort-suffix split, the account-aware option list for a
 * Codex-subscription provider, the model-list merge used when a refresh lands,
 * and which generation controls (temperature / top-p / thinking) a provider
 * forwards at all.
 *
 * The sentinels, effort ladders and the Antigravity split are re-exported from
 * the pure leaf `server/lib/providerModels.js`; `effortLevelsForProvider` /
 * `resolveCliEffort` delegate to the server's and add the one rung the browser
 * needs — the ladder the server publishes on a sanitized provider inventory.
 * The generation-control tables still mirror `server/lib/opencodeConfig.js` /
 * `server/lib/aiToolkit/internal/generationOptions.js`. Helpers marked
 * CLIENT-ONLY are rendering concerns with no server twin.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isGatewayBackedProvider } from './providerGateways.js';
import { isAntigravityProvider, isClaudeCommandProvider, isCodexSubscriptionProvider, isOllamaBackedProvider } from './providerTypes.js';
import {
  antigravityBaseModels,
  clampEffortToLadder,
  effortLevelsForProvider as serverEffortLevelsForProvider,
  filterSelectableModels,
  isConfiguredDefaultModel,
  splitAntigravityModel,
} from '../../../server/lib/providerModels.js';

export {
  CODEX_CONFIGURED_DEFAULT,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  KIMI_CONFIGURED_DEFAULT,
  isConfiguredDefaultModel,
  filterSelectableModels,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  CODEX_ULTRA_EFFORT_LEVELS,
  ANTIGRAVITY_EFFORT_LEVELS,
  OPENCODE_LOCAL_EFFORT_LEVELS,
  CURSOR_EFFORT_LEVELS,
  GROK_EFFORT_LEVELS,
  splitAntigravityModel,
  antigravityBaseModels,
  antigravityModelEffortLevels,
} from '../../../server/lib/providerModels.js';

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
 * effort control. The server's `effortLevelsForProvider` answers for every
 * provider it can positively identify; a sanitized provider inventory — which
 * omits command/path/env so a renamed custom CLI leaks no machine detail — is
 * answered from the ladder the server published on it instead. Drives the
 * "Effort (optional)" select in task/schedule forms.
 *
 * `model` narrows the Antigravity ladder to the tiers that base model actually
 * offers (see above). The server's null is FINAL for Antigravity: it means the
 * catalog names no tier for this model, and the published provider-level ladder
 * must not resurrect an effort agy would reject.
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model]
 * @returns {readonly string[]|null}
 */
export const effortLevelsForProvider = (provider, model = null) => {
  if (!provider) return null;
  const known = serverEffortLevelsForProvider(provider, model);
  if (known || isAntigravityProvider(provider)) return known;
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

/**
 * The level a stored effort will ACTUALLY run at on this provider, or null when
 * no flag is emitted: the server's clamp, over the ladder resolved here (which
 * can come from the server-published fields).
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
export const resolveCliEffort = (effort, provider, model = null) =>
  clampEffortToLadder(effort, effortLevelsForProvider(provider, model));

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
