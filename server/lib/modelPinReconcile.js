/**
 * Retired-model-pin reconciliation (#7315).
 *
 * A pin PortOS does not own cannot be healed by substitution (that would render
 * under a different model's name and bury the vendor's "unknown model" error),
 * so a stale pin can only be SURFACED. This leaf is the membership half: given
 * a pin and the provider record(s) that serve it (several for a reviewer pin),
 * is the id still listed by ANY of them?
 *
 * The comparison is STATE-BASED ("is this pin in today's catalog?") rather than
 * a diff of one refresh against the previous one: a diff never notices pins that
 * rotted earlier, and the state form is idempotent, so clearing a pin removes
 * its warning immediately with nothing persisted, migrated or federated.
 *
 * Pure leaf (nothing outside `server/lib`, no Node built-ins) so the audit
 * service, the route, and the suite share one membership rule.
 */

import { modelPinIsOffered } from './modelPinMembership.js';
import {
  antigravityBaseModels,
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
 * THE membership rule, `modelPinIsOffered`, verbatim — plus the one case a
 * RETIREMENT check answers differently from a spawn-time check: nothing is
 * pinned at all, and a configured-default SENTINEL, which is a posture ("use
 * the CLI's own default") rather than a model and so can never be retired. The
 * rule itself declines the sentinel deliberately — only a CLI that has its own
 * default can be handed one, so "is it missing from this catalog?" is the wrong
 * question there, and answering it `true` would let an API provider store one.
 * This wrapper also gives the audit a signature in its own vocabulary
 * (`(provider, modelId)`, the pin's side of the question).
 *
 * The rule's posture is what makes this safe to surface in a UI: every case
 * where the answer is genuinely UNKNOWN answers `true`. A false "your pin is
 * gone" tells the user to change a setting that works, which is strictly worse
 * than missing one. `modelPinIsOffered` supplies an empty catalog, a
 * local-daemon provider, and the two same-model-spelled-differently tolerances
 * (agy base ids, OpenCode's `namespace/model` form); this function adds three
 * more — nothing is pinned, the sentinel above, and no provider record could be
 * resolved to compare against.
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
  return modelPinIsOffered(provider, id);
}

/**
 * THE coercion from a pin's provider field(s) to the id list it is judged
 * against — trimmed, blanks dropped.
 *
 * Most pins name exactly one record. A REVIEWER pin (#7339) names a binary that
 * several records front, so it carries `providerIds` — see
 * `reviewerProviderMatchers.js` for which records, and why collapsing them to
 * one would produce a false retirement for a model another still lists.
 *
 * Exported so the audit's descriptor builder normalizes with the same definition.
 *
 * @param {{providerId?: unknown, providerIds?: unknown}} pin
 * @returns {string[]}
 */
export const pinProviderIds = (pin) =>
  (Array.isArray(pin?.providerIds) ? pin.providerIds : [pin?.providerId])
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean);

/**
 * Is `modelId` still served by ANY of `providerIds`?
 *
 * Deliberately `some`, not `every`: a pin is stale only when every named
 * provider fails to list it. One record that still offers the id means the
 * reviewer's binary can still be handed it, so there is nothing to warn about.
 *
 * An EMPTY list answers `true`, matching `providerCatalogListsModel`'s
 * no-provider arm — a pin nobody could resolve a catalog for is unjudgeable,
 * and `[].some()` would otherwise report every one of them as retired. An id
 * that resolves to no record is likewise `true` (that arm again), so an
 * unknown provider among several still answers "still served".
 *
 * @param {string[]} providerIds
 * @param {Record<string, object>} byId
 * @param {string|null|undefined} modelId
 * @returns {boolean}
 */
const anyProviderListsModel = (providerIds, byId, modelId) =>
  providerIds.length === 0 || providerIds.some((id) => providerCatalogListsModel(byId[id], modelId));

/**
 * How a surface NAMES the records a pin was judged against.
 *
 * Shared so the panel and the notification card cannot describe one pin
 * differently — naming only the first record would have the panel say
 * "Claude Code · Claude Code TUI" while the card said "Claude Code", from the
 * same descriptor. Falls back to the raw id for a record the catalog no longer
 * carries, which is itself a thing the user needs to see.
 *
 * @param {{providerIds?: string[]}} pin
 * @param {Record<string, {name?: string}>} providers
 * @returns {string}
 */
export const pinProviderNames = (pin, providers) =>
  pinProviderIds(pin).map((id) => providers?.[id]?.name || id).join(' · ');

/**
 * Which of `pins` name a model their provider no longer lists.
 *
 * A pin descriptor is `{ id, providerId | providerIds, model, label, location, ... }`;
 * every field rides through onto the warning untouched so a collector can carry
 * whatever the UI needs (a deep link, a clearability flag) without this leaf
 * knowing about it. Warnings are returned in the order the pins were given, so
 * a stable collector order yields a stable panel.
 *
 * Each warning carries `providerIds` — the full judged list, and the ONE field
 * a surface reads — so the panel can union the catalogs it should offer instead
 * of showing one record's, and `pinProviderNames` can name them all.
 *
 * `providers` is the provider records keyed by id. A pin naming a provider that
 * is not in the map is left alone — see `providerCatalogListsModel`.
 *
 * @param {Array<{id:string, providerId?:string, providerIds?:string[], model:string}>} pins
 * @param {Record<string, {id?:string, name?:string, models?:unknown[]}>} providers
 * @returns {Array<object>}
 */
export function reconcileModelPins(pins, providers) {
  const byId = providers && typeof providers === 'object' ? providers : {};
  // One pass, and the descriptor is built only for a pin that is actually
  // stale. The healthy pins are the overwhelming majority — an install with a
  // render pin on every universe, series, sprite, deck and music video reaches
  // here with hundreds of them for a result that is normally empty — so a
  // map-then-filter would spread every one of them just to drop it.
  return (Array.isArray(pins) ? pins : []).flatMap((pin) => {
    const model = typeof pin?.model === 'string' ? pin.model.trim() : '';
    if (model === '') return [];
    const providerIds = pinProviderIds(pin);
    return anyProviderListsModel(providerIds, byId, model) ? [] : [{ ...pin, model, providerIds }];
  });
}
