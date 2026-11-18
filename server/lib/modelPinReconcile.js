/**
 * Retired-model-pin reconciliation (#7315): is a pin's model still listed by ANY of the provider record(s) serving
 * it?
 *
 * State-based, not a refresh diff, so clearing a pin clears its warning with nothing persisted. Pure leaf: nothing
 * outside `server/lib`, no Node built-ins.
 */

import { modelPinIsOffered } from './modelPinMembership.js';
import {
  antigravityBaseModels,
  filterSelectableModels,
  isAntigravityProvider,
  isConfiguredDefaultModel,
} from './provider/providerModels.js';

/**
 * Listed string model ids minus the CLI-default sentinels (a posture, not a model).
 * @param {{models?: unknown[]}|null|undefined} provider
 * @returns {string[]}
 */
function catalogModelIds(provider) {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return filterSelectableModels(models.filter((m) => typeof m === 'string'));
}

/**
 * What the catalog offers: agy collapses to base ids (tier rides on `--effort`), others verbatim.
 * @param {{models?: unknown[]}|null|undefined} provider
 * @returns {string[]}
 */
export function catalogOfferings(provider) {
  const ids = catalogModelIds(provider);
  return isAntigravityProvider(provider) ? antigravityBaseModels(ids) : ids;
}

/**
 * Is `modelId` still served by `provider`? Every genuinely UNKNOWN case (nothing pinned, a
 * configured-default sentinel, no provider record) answers `true`: a false "your pin is gone" is
 * worse than a missed one.
 * @param {{id?:string, command?:string, models?:unknown[]}|null|undefined} provider
 * @param {string|null|undefined} modelId
 * @returns {boolean}
 */
export function providerCatalogListsModel(provider, modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return true;
  const id = modelId.trim();
  if (isConfiguredDefaultModel(id)) return true;
  if (!provider) return true;
  return modelPinIsOffered(provider, id);
}

/**
 * The trimmed, non-blank provider id list a pin is judged against. A REVIEWER pin (#7339) carries
 * `providerIds` (see `reviewerProviderMatchers.js`); collapsing to one would falsely retire a model
 * another record lists.
 * @param {{providerId?: unknown, providerIds?: unknown}} pin
 * @returns {string[]}
 */
export const pinProviderIds = (pin) =>
  (Array.isArray(pin?.providerIds) ? pin.providerIds : [pin?.providerId])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean);

/**
 * `some`, not `every`; an empty list or unknown id is unjudgeable and answers true.
 * @param {string[]} providerIds
 * @param {Record<string, object>} byId
 * @param {string|null|undefined} modelId
 * @returns {boolean}
 */
const anyProviderListsModel = (providerIds, byId, modelId) =>
  providerIds.length === 0 || providerIds.some((id) => providerCatalogListsModel(byId[id], modelId));

/**
 * Names the records a pin was judged against (shared by panel and card); raw id when the record is gone.
 * @param {{providerIds?: string[]}} pin
 * @param {Record<string, {name?: string}>} providers
 * @returns {string}
 */
export const pinProviderNames = (pin, providers) =>
  pinProviderIds(pin).map((id) => providers?.[id]?.name || id).join(' · ');

/**
 * Which of `pins` (`{ id, providerId | providerIds, model, ... }`) name a model their provider no
 * longer lists. Extra fields pass through in input order; each warning carries the judged `providerIds`.
 * @param {Array<{id:string, providerId?:string, providerIds?:string[], model:string}>} pins
 * @param {Record<string, {id?:string, name?:string, models?:unknown[]}>} providers
 * @returns {Array<object>}
 */
export function reconcileModelPins(pins, providers) {
  const byId = providers && typeof providers === 'object' ? providers : {};
  // One pass: healthy pins are the overwhelming majority, so build the descriptor only for stale ones.
  return (Array.isArray(pins) ? pins : []).flatMap((pin) => {
    const model = typeof pin?.model === 'string' ? pin.model.trim() : '';
    if (model === '') return [];
    const providerIds = pinProviderIds(pin);
    return anyProviderListsModel(providerIds, byId, model) ? [] : [{ ...pin, model, providerIds }];
  });
}
