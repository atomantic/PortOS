/**
 * Retired-model-pin reconciliation (#7315).
 *
 * A vendor retires a model id, the install's catalog refresh picks that up, and
 * every stored pin still naming the retired id keeps sitting in settings —
 * rotting silently until a render or a scheduled run dies with a raw vendor
 * error naming a model the user no longer remembers choosing. That already
 * happened once to the ONE pin PortOS owns (`AGY_IMAGEGEN_DEFAULT_MODEL`, fixed
 * in #7314 by a render-time re-point gated on `modelIsShippedDefault`).
 *
 * A pin PortOS does NOT own cannot be healed the same way. Substituting a
 * user's pin would render something different under their chosen model's name
 * and bury the vendor's own "unknown model" error, so such a pin can only be
 * SURFACED. This leaf is the membership half of that: given a pin and the
 * provider record that serves it, is the id still listed?
 *
 * The comparison is deliberately STATE-BASED ("is this pin in today's
 * catalog?") rather than a diff of one refresh against the previous one. The
 * diff form only ever notices retirements that happen after it ships, so every
 * pin that rotted before — including the ones this issue was filed about — stays
 * invisible until the vendor happens to retire something else. It is also
 * idempotent: clearing a pin makes its warning disappear immediately instead of
 * waiting for the next refresh, and nothing has to be persisted, migrated, or
 * kept from federating.
 *
 * Pure leaf (nothing outside `server/lib`, no Node built-ins) so the audit
 * service, the route, and the suite can all share one membership rule.
 */

import { modelPinIsOffered } from './localProviderRuntime.js';
import {
  antigravityBaseModels,
  antigravityCatalogListsModel,
  filterSelectableModels,
  isAntigravityProvider,
  isConfiguredDefaultModel,
} from './providerModels.js';

/**
 * The string model ids a provider record actually lists, with the
 * "use the CLI's own default" sentinels dropped — they are a posture, not a
 * model, and can never be the thing a pin names.
 * Private: `catalogOfferings` is the public view, and a caller wanting the raw
 * listed ids already has `filterSelectableModels`.
 * @param {{models?: unknown[]}|null|undefined} provider
 * @returns {string[]}
 */
function catalogModelIds(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return filterSelectableModels(models.filter((m) => typeof m === 'string'));
}

/**
 * The user-facing "what the catalog now offers" list for a provider: agy's
 * family collapses to base ids (the effort tier rides on `--effort`, so
 * `gemini-3.6-flash-low` is not a different model to pick), everything else is
 * its listed ids verbatim.
 * @param {{models?: unknown[]}|null|undefined} provider
 * @returns {string[]}
 */
export function catalogOfferings(provider) {
  const ids = catalogModelIds(provider);
  return isAntigravityProvider(provider) ? antigravityBaseModels(ids) : ids;
}

/**
 * Is `modelId` still served by `provider`?
 *
 * Delegates the base rule to `modelPinIsOffered` — the repo's existing "is this
 * stored pin valid against this provider record?" test — and adds only the
 * tolerances a RETIREMENT check needs on top. Re-deriving the base rule here
 * would have dropped its local-daemon carve-out, which is load-bearing: an
 * Ollama/LM Studio/MTPLX-backed provider's `models` array is a stale cached
 * snapshot while the daemon on this machine is the authority, so judging a
 * local pin against the record reports a model that is installed and serving as
 * retired — and this feature would then offer a one-click button to delete it.
 *
 * That is the whole reason for the posture below: every case where the answer
 * is genuinely UNKNOWN answers `true`. A false "your pin is gone" tells the
 * user to change a setting that works, which is strictly worse than missing
 * one. `modelPinIsOffered` supplies two of those cases (an empty catalog, a
 * local-daemon provider); this function adds two more (nothing is pinned, and
 * no provider record could be resolved to compare against).
 *
 * The two tolerances layered on top are both "the same model, spelled
 * differently", not a laxer rule:
 *
 *  - **agy compares on BASE ids.** Once `--effort` carries the tier,
 *    `gemini-3.6-flash` and `gemini-3.6-flash-low` are the same `--model`
 *    value, and a tier the base does not offer is clamped by
 *    `antigravityModelEffortLevels` rather than being a different model.
 *  - **OpenCode addresses models as `namespace/model`.** A pin is stored BARE
 *    and namespaced at spawn (`prefixOpencodeModel`), so a catalog holding the
 *    qualified form — or a pin hand-written that way — is the same model.
 *
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} modelId
 * @returns {boolean}
 */
export function providerCatalogListsModel(provider, modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return true;
  const id = modelId.trim();
  if (isConfiguredDefaultModel(id)) return true;
  if (!provider) return true;
  // Empty catalog, local daemon, or a plain exact match — all "still served".
  if (modelPinIsOffered(provider, id)) return true;

  const ids = catalogModelIds(provider);
  if (isAntigravityProvider(provider)) return antigravityCatalogListsModel(id, ids);
  // `bare` is a no-op on an id with no slash, which is exactly how OpenCode
  // itself splits `provider/model` — on the FIRST slash only.
  const bare = (value) => value.slice(value.indexOf('/') + 1);
  return ids.some((listed) => bare(listed) === bare(id));
}

/**
 * Which of `pins` name a model their provider no longer lists.
 *
 * A pin descriptor is `{ id, providerId, model, label, location, ... }`; every
 * field rides through onto the warning untouched so a collector can carry
 * whatever the UI needs (a deep link, a clearability flag) without this leaf
 * knowing about it. Warnings are returned in the order the pins were given, so
 * a stable collector order yields a stable panel.
 *
 * `providers` is the provider records keyed by id. A pin naming a provider that
 * is not in the map is left alone — see `providerCatalogListsModel`.
 *
 * @param {Array<{id:string, providerId:string, model:string}>} pins
 * @param {Record<string, {id?:string, name?:string, models?:unknown[]}>} providers
 * @returns {Array<object>}
 */
export function reconcileModelPins(pins, providers) {
  const byId = providers && typeof providers === 'object' ? providers : {};
  return (Array.isArray(pins) ? pins : [])
    .filter((pin) => pin && typeof pin.model === 'string' && pin.model.trim() !== '')
    .filter((pin) => !providerCatalogListsModel(byId[pin.providerId], pin.model))
    .map((pin) => ({ ...pin, model: pin.model.trim() }));
}
