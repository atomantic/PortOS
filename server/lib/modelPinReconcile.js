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
 * provider record — or records, for a reviewer pin whose binary several records
 * front (#7339) — that serve it, is the id still listed by ANY of them?
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
 * Those tolerances used to be layered HERE, above a stricter
 * `modelPinIsOffered`, which meant the audit and the three spawn-time callers
 * disagreed about the same pin: `cliProviderRun` rejected a bare agy base id
 * against a suffix-only catalog and silently fell back to the provider default
 * — for a model it would itself have spawned. They moved down into the rule
 * (#7327), so there is now one answer and the browser can mirror it.
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
 * The provider ids a pin is judged against, ALWAYS as a list.
 *
 * Most pins name exactly one record. A REVIEWER pin (#7339) names a binary, and
 * PortOS ships more than one record per binary — `claude` spans `claude-code`
 * and `claude-code-tui`, `grok` spans `grok-cli` and its TUI — so it carries
 * `providerIds`. Collapsing those to one record would produce a false
 * retirement for a model the OTHER record still lists, which is exactly the
 * failure this whole audit's posture exists to avoid.
 */
const pinProviderIds = (pin) =>
  (Array.isArray(pin?.providerIds) ? pin.providerIds : [pin?.providerId])
    .filter((id) => typeof id === 'string' && id.trim() !== '');

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
 * Which of `pins` name a model their provider no longer lists.
 *
 * A pin descriptor is `{ id, providerId | providerIds, model, label, location, ... }`;
 * every field rides through onto the warning untouched so a collector can carry
 * whatever the UI needs (a deep link, a clearability flag) without this leaf
 * knowing about it. Warnings are returned in the order the pins were given, so
 * a stable collector order yields a stable panel.
 *
 * Each warning is normalized to carry `providerIds` — the full judged list —
 * so the panel can union the catalogs it should offer instead of showing one
 * record's. `providerId` (the first, preferred record) rides through untouched
 * for the single-provider sources and is what a UI names the pin's provider by.
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
  return (Array.isArray(pins) ? pins : [])
    .filter((pin) => pin && typeof pin.model === 'string' && pin.model.trim() !== '')
    .map((pin) => ({ ...pin, model: pin.model.trim(), providerIds: pinProviderIds(pin) }))
    .filter((pin) => !anyProviderListsModel(pin.providerIds, byId, pin.model));
}
