/**
 * Which MODEL and EFFORT a run resolves to, and what a picker may list.
 *
 * Covers CLI-default sentinels, effort ladders and clamp, the Antigravity
 * base-model/effort-suffix split, account-aware Codex options, model-list merges,
 * and which generation controls a provider forwards.
 *
 * Sentinels, ladders and the Antigravity split re-export `server/lib/provider/providerModels.js`;
 * pin membership is the server's `modelPinIsOffered` (`server/lib/modelPinMembership.js`),
 * never a second rule. Generation-control tables mirror `server/lib/opencodeConfig.js`
 * and `server/lib/aiToolkit/internal/generationOptions.js`. CLIENT-ONLY helpers have
 * no server twin. Re-exported by `./providers.js`.
 */

import { isGatewayBackedProvider } from './providerGateways.js';
import { isAntigravityProvider, isClaudeCommandProvider, isCodexSubscriptionProvider, isOllamaBackedProvider, hasLocalRuntimeMarker } from './providerTypes.js';
import {
  antigravityBaseModels,
  clampEffortToLadder,
  effortLevelsForProvider as serverEffortLevelsForProvider,
  filterSelectableModels,
  isConfiguredDefaultModel,
  splitAntigravityModel,
} from '../../../server/lib/provider/providerModels.js';
// Taken from the browser-safe leaf: `localProviderRuntime.js` reaches `zod` (not a client dependency).
import { modelPinIsOffered } from '../../../server/lib/modelPinMembership.js';

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
} from '../../../server/lib/provider/providerModels.js';

/**
 * Alphabetize model options (strings or `{ id, name }`) by displayed name without
 * mutating the catalog. CLIENT-ONLY — presentation order must not change
 * default-model resolution.
 */
export const sortProviderModels = (models) => [...models].sort((a, b) => {
  const label = (model) => typeof model === 'string' ? model : model?.name || model?.id || '';
  return label(a).localeCompare(label(b), 'en', { sensitivity: 'base' });
});

/**
 * The configured-default sentinel carried in a provider's model list, or null.
 * `filterSelectableModels` strips sentinels, so a provider whose `defaultModel`
 * IS the sentinel (agy) would render a `<select>` matching no `<option>`; the
 * provider-edit form uses this to render an explicit option.
 * @param {string[]|null|undefined} models
 * @returns {string|null}
 */
export const configuredDefaultIn = (models) =>
  (models || []).find(isConfiguredDefaultModel) || null;


/**
 * The provider's selectable model list as pickers show it. Only rewrites
 * Antigravity (base models instead of one row per effort tier); the single place
 * the normalization lives.
 * @param {{id?:string, command?:string}|null|undefined} provider
 * @param {unknown[]} models
 * @returns {unknown[]}
 */
export const selectableModelsForProvider = (provider, models) =>
  isAntigravityProvider(provider) ? antigravityBaseModels(models) : (models || []);

/**
 * Keeps a stored-but-no-longer-listed Antigravity id (saved before the model/effort split, e.g. `gemini-3.6-flash-high`) visible as its own option so the select isn't blank.
 * Only an id with an effort SUFFIX: a bare "not in the list" test would re-surface the hidden default sentinel and typo'd pins.
 * Not built on `withUnlistedOption`: this list is flat id strings and appends rather than prepends. CLIENT-ONLY.
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
 * The model ids in a signed-in ChatGPT account's catalog, or `null` when the catalog is not a SUCCESSFUL read: never-fetched and failed
 * (last-known-good only) collapse to `null` so an offline user keeps the shipped list; `[]` means the account exposes none. CLIENT-ONLY.
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
 * The RAW model list a picker reads, before sentinel/effort/hardware filtering: the account catalog when fetched, else `models`, else
 * `defaultModel` when empty (`[]` is truthy, so a bare `||` would not fall through). A successfully-read EMPTY catalog stays `[]`:
 * offering the default would restore an un-runnable option. CLIENT-ONLY.
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
 * The option list for a picker, plus WHERE it came from: the account's models for a Codex-subscription provider with a fetched catalog, else the shipped list.
 *
 * ADDITIVE: a stored `selectedModel` the list no longer offers stays as its own option, reported via `unlistedSelection`. The shipped branch asks
 * `modelPinIsOffered` (the spawner's rule); the ACCOUNT branch keeps a bare membership test because an empty account catalog means the pin IS
 * unavailable. CLIENT-ONLY.
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
  if (!catalog) {
    // SELECTABLE and FLAGGED differ: anything stored and not already an option must become one (or the select is blank); only the flag asks if the pin is dead.
    const stored = !!selectedModel && !isConfiguredDefaultModel(selectedModel);
    const listed = shipped.some((entry) => (typeof entry === 'string' ? entry : entry?.id) === selectedModel);
    return {
      models: stored && !listed ? [...shipped, selectedModel] : shipped,
      source: MODEL_SOURCE.shipped,
      unlistedSelection: stored && !modelPinIsOffered(provider, selectedModel),
    };
  }
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
 * The option list for a picker with an effort control that reads `provider.models` directly: base models, sentinels stripped, plus any legacy
 * suffixed pin. Codex-subscription providers use `resolveProviderModelOptions`. CLIENT-ONLY.
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} selectedModel
 * @returns {unknown[]}
 */
export const effortAwareModelOptions = (provider, selectedModel) =>
  resolveProviderModelOptions(provider, selectedModel).models;

/**
 * The model a run will ACTUALLY use: the explicit pin, else the provider default
 * (a blank model falls through to `defaultModel`). CLIENT-ONLY.
 * @param {{defaultModel?:string}|null|undefined} provider
 * @param {string|null|undefined} model
 * @returns {string}
 */
export const effectiveModelFor = (provider, model) => model || provider?.defaultModel || '';

/**
 * Seeds a picker's model and effort from a record that may predate the split (`gemini-3.6-flash-high` → model + `high`); a stored `effort` wins. CLIENT-ONLY.
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
 * The effort levels a provider's CLI accepts, or null when it has no effort control; a sanitized inventory is answered from the ladder the server
 * published on it. `model` narrows the Antigravity ladder, where the server's null is FINAL.
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
 * The effort a picker keeps after its MODEL changed: the current one, or `''` when the new model has no effort control (a stale effort would
 * still be sent). A merely NARROWED ladder is left alone; `EffortSelect` shows the clamp. CLIENT-ONLY.
 * @param {{id?:string, command?:string, models?:unknown[], defaultModel?:string}|null|undefined} provider
 * @param {string|null|undefined} model - the NEWLY selected model
 * @param {string|null|undefined} effort - the currently selected effort
 * @returns {string}
 */
export const effortSurvivingModel = (provider, model, effort) =>
  (effortLevelsForProvider(provider, effectiveModelFor(provider, model)) ? (effort || '') : '');

/**
 * The level a stored effort will ACTUALLY run at, or null when no flag is emitted: the server clamps (not drops) an out-of-ladder effort,
 * so the select needs this or it renders blank.
 * @param {string|null|undefined} effort
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null} [model] - narrows the Antigravity ladder (see effortLevelsForProvider)
 * @returns {string|null}
 */
export const resolveCliEffort = (effort, provider, model = null) =>
  clampEffortToLadder(effort, effortLevelsForProvider(provider, model));

/**
 * Union of model-id lists, de-duplicated, order-preserving, falsy dropped.
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
 * Merge a partial-update payload onto an existing provider record in place, so repointing doesn't clobber fields the payload didn't set
 * (a raw PATCH replaces top-level keys wholesale, dropping env vars and model history).
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
 * Which default generation controls the provider editor should offer, or null: only local OpenAI-compatible backends (Ollama, llama.cpp, MTPLX,
 * vLLM, direct or via OpenCode) and hosted gateways (OrcaRouter, OpenRouter) qualify. Controls are reported separately because forwarding is uneven
 * (gateways have no thinking toggle; the Claude harness on Ollama takes ONLY a thinking signal). MIRROR of `THINKING_STYLE` / `buildAgentGeneration`
 * in server/lib/opencodeConfig.js and `apiGenerationOptions` in server/lib/aiToolkit/internal/generationOptions.js; keep in lockstep.
 * @param {object|null|undefined} provider
 * @returns {{temperature:boolean, topP:boolean, thinking:boolean}|null}
 */
export const generationControlsFor = (provider) => {
  const gateway = isGatewayBackedProvider(provider);
  // LM Studio forwards temperature/top_p, but reasoning belongs to the LOADED model instance (THINKING_STYLE.lmstudio on the server: no toggle).
  const lmstudio = provider?.lmstudioBacked === true;
  const inkling = provider?.splashBacked === true || provider?.mkserveBacked === true;
  const local = isOllamaBackedProvider(provider) || hasLocalRuntimeMarker(provider);
  if (!local && !gateway) return null;
  if (isClaudeCommandProvider(provider)) {
    // A Claude harness owns its sampling; only a thinking signal is forwardable, and only on Ollama (`MAX_THINKING_TOKENS=0` in server/lib/cliChildEnv.js).
    return isOllamaBackedProvider(provider)
      ? { temperature: false, topP: false, thinking: true }
      : null;
  }
  // LM Studio joins the gateways in having no forwardable thinking signal.
  return { temperature: true, topP: true, thinking: !gateway && !lmstudio && !inkling };
};
