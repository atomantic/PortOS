import { getSettings, updateSettingsWith } from './settings.js';
import { listProviders, updateProvider } from './providers.js';
import { normalizeSubscriptionCosts } from './subscriptionCosts.js';
import { PROVIDER_FAMILIES, familyForProvider, familyLabel } from '../lib/providerFamilies.js';
import { normalizePlanTier } from '../lib/subscriptionPlanTiers.js';
import { mergeFamilyMap, normalizeFamilyMap } from '../lib/familySettingsMap.js';

/**
 * The subscription plans this install pays for: which ones are switched on,
 * which tier each is, and what each costs.
 *
 * PortOS-side METADATA and tracking only. Toggling a plan here flips the
 * `enabled` flag on that family's provider records — the same flag
 * `resolveEnabledFamilies` reads — so the install stops dispatching work to it.
 * It never reaches a vendor's billing system: nothing here purchases, cancels,
 * upgrades or downgrades anything at Anthropic, OpenAI, Google or xAI.
 *
 * Prices live in `subscriptionCosts.js` (settings `subscriptionCosts`) because
 * the savings math is their only consumer. Tiers live here (settings
 * `subscriptionPlanTiers`), both maps merging through `lib/familySettingsMap.js`
 * so their absent-vs-cleared contract is one rule rather than two copies.
 */

const SETTINGS_KEY = 'subscriptionPlanTiers';

/** Pure: normalize a whole tier map, dropping every cleared/invalid entry. */
export const normalizePlanTiers = (raw) => normalizeFamilyMap(raw, normalizePlanTier);

/** Stored plan tiers, `{ [family]: label }`. */
export async function getPlanTiers() {
  const settings = await getSettings();
  return normalizePlanTiers(settings?.[SETTINGS_KEY]);
}

/**
 * Merge a patch of plan tiers into settings and return the normalized map.
 * Omitted keeps, empty clears — see `mergeFamilyMap` for why that split is
 * load-bearing. `options` carries the operator actor, as the price saver's does.
 */
export async function savePlanTiers(patch, options) {
  const next = await updateSettingsWith((current) => ({
    ...current,
    [SETTINGS_KEY]: mergeFamilyMap(current?.[SETTINGS_KEY], patch, normalizePlanTier),
  }), options);
  return normalizePlanTiers(next?.[SETTINGS_KEY]);
}

/**
 * Pure: the provider records that belong to each family, keyed by family id.
 *
 * `familyForProvider` already excludes local-runtime wrappers (an Ollama-backed
 * `claude-*` provider has no subscription to meter), so a row here only ever
 * holds providers whose enablement really is the plan's enablement.
 */
export function groupProvidersByFamily(providers) {
  const byFamily = new Map();
  for (const provider of providers || []) {
    const family = familyForProvider(provider);
    if (!family) continue;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(provider);
  }
  return byFamily;
}

/** The trimmed provider projection a row carries — never the full config. */
const providerSummary = (provider) => ({
  id: provider.id,
  name: provider.name || provider.id,
  enabled: provider.enabled === true,
});

/**
 * Pure: one row per manageable subscription — every family with at least one
 * provider CONFIGURED (enabled or not), plus every family the user has priced
 * or tiered.
 *
 * Deliberately NOT `resolveSubscriptionFamilies` (subscriptionCosts.js), which
 * answers a different question for the savings card: it starts from the
 * ENABLED families, because a plan that did no work in the window has no
 * figures to show. This page has to list a configured-but-switched-off plan —
 * that row is the only way to switch it back on — so it starts from configured
 * instead, and has no use for that function's spend-in-window extras.
 *
 * What the two DO share is the data-preservation rule: a priced or tiered
 * family with no providers left still gets a row, or its stored value becomes
 * invisible and unclearable. That covers a family id an older install stored
 * and this registry no longer knows, which `familyLabel` renders by its raw id.
 *
 * `enabled` mirrors `resolveEnabledFamilies`: a plan is on when ANY of its
 * providers is enabled. Both now derive membership from `familyForProvider`,
 * so the toggle and the savings block's `enabled` flag cannot disagree.
 */
export function buildSubscriptionFamilies({ providers = [], costs = {}, tiers = {} } = {}) {
  const byFamily = groupProvidersByFamily(providers);
  // Registry order first, then any stored-only id, so the rows are stable.
  const ids = [...new Set([...PROVIDER_FAMILIES.map((f) => f.id), ...Object.keys(costs), ...Object.keys(tiers)])];
  return ids
    .map((id) => ({ id, members: byFamily.get(id) || [] }))
    .filter(({ id, members }) => members.length > 0 || costs[id] != null || tiers[id] != null)
    .map(({ id, members }) => ({
      family: id,
      label: familyLabel(id),
      enabled: members.some((provider) => provider.enabled === true),
      monthlyCost: costs[id] ?? 0,
      planTier: tiers[id] ?? null,
      providers: members.map(providerSummary),
    }));
}

/**
 * The Subscriptions page's row set.
 *
 * ONE `getSettings()` for both stored maps rather than `getSubscriptionCosts()`
 * + `getPlanTiers()`: each of those deep-clones the whole settings tree, and
 * the two keys sit in the same snapshot.
 */
export async function getSubscriptionOverview() {
  const [providers, settings] = await Promise.all([listProviders(), getSettings()]);
  return {
    families: buildSubscriptionFamilies({
      providers,
      costs: normalizeSubscriptionCosts(settings?.subscriptionCosts),
      tiers: normalizePlanTiers(settings?.[SETTINGS_KEY]),
    }),
  };
}

/**
 * Switch a whole subscription on or off by flipping `enabled` on every provider
 * record in that family.
 *
 * Writes are SEQUENTIAL, not `Promise.all`: every `updateProvider` is a
 * read-merge-write of the same providers.json, so firing them concurrently
 * would let the last write win and silently drop its siblings' changes.
 *
 * A family with no providers configured is reported as `applied: false` rather
 * than treated as an error — the row exists because the plan is priced, and
 * there is simply nothing local to toggle. Its price stays stored either way.
 */
export async function setSubscriptionEnabled(family, enabled) {
  const members = groupProvidersByFamily(await listProviders()).get(family) || [];
  const changed = [];
  for (const provider of members) {
    if ((provider.enabled === true) === enabled) continue;
    await updateProvider(provider.id, { enabled });
    changed.push(provider.id);
  }
  return {
    family,
    enabled: members.length ? enabled : false,
    applied: members.length > 0,
    changed,
  };
}
