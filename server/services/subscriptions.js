import { getSettings, updateSettingsWith } from './settings.js';
import { getAllProviders, updateProvider } from './providers.js';
import { getSubscriptionCosts } from './subscriptionCosts.js';
import { PROVIDER_FAMILIES, familyForProvider, familyLabel } from '../lib/providerFamilies.js';
import { normalizePlanTier, normalizePlanTiers } from '../lib/subscriptionPlanTiers.js';
import { isPlainObject } from '../lib/objects.js';

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
 * `subscriptionPlanTiers`) with the same patch semantics, and this module is
 * what joins price + tier + enablement + provider membership into the one row
 * the Subscriptions page renders.
 */

const SETTINGS_KEY = 'subscriptionPlanTiers';

/** Stored plan tiers, `{ [family]: label }`. */
export async function getPlanTiers() {
  const settings = await getSettings();
  return normalizePlanTiers(settings?.[SETTINGS_KEY]);
}

/**
 * Merge a patch of plan tiers into settings and return the normalized map.
 *
 * Absent vs. present-but-empty are DIFFERENT, exactly as for prices: a family
 * the patch omits keeps its stored tier, while one sent as `null`/`""` is an
 * intentional clear and is deleted. Without that split an editor submitting
 * only changed rows could never remove a tier the user stopped being on.
 */
export async function savePlanTiers(patch, options) {
  const incoming = isPlainObject(patch) ? patch : {};
  const next = await updateSettingsWith((current) => {
    const merged = { ...normalizePlanTiers(current?.[SETTINGS_KEY]) };
    for (const [family, value] of Object.entries(incoming)) {
      const tier = normalizePlanTier(value);
      if (tier === null) delete merged[family];
      else merged[family] = tier;
    }
    return { ...current, [SETTINGS_KEY]: merged };
  }, options);
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
 * provider configured, plus every family the user has priced or tiered.
 *
 * That second half is the same rule `resolveSubscriptionFamilies` follows and
 * for the same reason: a priced family whose providers were all deleted must
 * keep a row, or its stored price becomes invisible and unclearable. A family
 * id that no longer exists in `PROVIDER_FAMILIES` (an older install's leftover)
 * still gets a row for exactly that reason, labelled by its raw id.
 *
 * `enabled` mirrors `resolveEnabledFamilies`: a plan is on when ANY of its
 * providers is enabled, so the toggle and the savings block's `enabled` flag
 * can never disagree.
 */
export function buildSubscriptionFamilies({ providers = [], costs = {}, tiers = {} } = {}) {
  const byFamily = groupProvidersByFamily(providers);
  const known = PROVIDER_FAMILIES
    .map((family) => ({ id: family.id, label: family.label, members: byFamily.get(family.id) || [] }))
    .filter((row) => row.members.length > 0 || costs[row.id] != null || tiers[row.id] != null);
  const knownIds = new Set(PROVIDER_FAMILIES.map((family) => family.id));
  const orphans = [...new Set([...Object.keys(costs), ...Object.keys(tiers)])]
    .filter((id) => !knownIds.has(id))
    .map((id) => ({ id, label: familyLabel(id), members: [] }));
  return [...known, ...orphans].map((row) => ({
    family: row.id,
    label: row.label,
    enabled: row.members.some((provider) => provider.enabled === true),
    monthlyCost: costs[row.id] ?? 0,
    planTier: tiers[row.id] ?? null,
    providers: row.members.map(providerSummary),
  }));
}

/** The whole Subscriptions page model: rows plus the raw stored maps. */
export async function getSubscriptionOverview() {
  const [result, costs, tiers] = await Promise.all([getAllProviders(), getSubscriptionCosts(), getPlanTiers()]);
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  return { families: buildSubscriptionFamilies({ providers, costs, tiers }), costs, tiers };
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
  const result = await getAllProviders();
  const providers = Array.isArray(result) ? result : (result?.providers || []);
  const members = groupProvidersByFamily(providers).get(family) || [];
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
