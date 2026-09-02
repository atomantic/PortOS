/**
 * Which federated instances pay API rates instead of the user's subscriptions.
 *
 * The Across Instances card prices every machine the same way — published API
 * rates — so a box that actually pays those rates inflates the combined
 * "what subscriptions saved me" total. Marking it API-billed leaves the row
 * listed (the spend is still real) but drops it from the combined figures.
 *
 * Machine-local, stored in `data/settings.json` under
 * `usageApiBilledInstanceIds`. It is THIS install's view of which fleet
 * members ride the plans, not a property of the instance itself, and never
 * rides the usage digest. A user looking at Usage on another machine sets
 * the same toggle there.
 */

import { getSettings, updateSettingsWith } from './settings.js';

const SETTINGS_KEY = 'usageApiBilledInstanceIds';

// Same cap as stored peer digests: a home federation is a handful of machines.
// The list only exists so a restore/hand-edit can't grow settings.json without
// bound; the route schema enforces the same ceiling on the way in.
const MAX_IDS = 64;
const MAX_ID_LEN = 200;

const isInstanceId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN;

/**
 * Pure: stored/incoming ids as a de-duplicated list. Non-arrays, blanks,
 * over-long ids, and anything past the cap are dropped so a corrupt settings
 * slice can't poison the fleet total.
 */
export function normalizeApiBilledInstanceIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    if (!isInstanceId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

/** Instance ids that pay API rates and must not count toward fleet totals. */
export async function getApiBilledInstanceIds() {
  const settings = await getSettings();
  return normalizeApiBilledInstanceIds(settings?.[SETTINGS_KEY]);
}

/**
 * Replace the whole API-billed set. Used by a settings PUT that carries the
 * slice (restore / generic client) so it goes through the same normalizer as
 * the per-row toggle rather than landing unvalidated.
 */
export async function saveApiBilledInstanceIds(ids, options) {
  const normalized = normalizeApiBilledInstanceIds(ids);
  const next = await updateSettingsWith((current) => (
    { ...current, [SETTINGS_KEY]: normalized }
  ), options);
  return normalizeApiBilledInstanceIds(next?.[SETTINGS_KEY]);
}

/**
 * Per-row toggle: `usesSubscriptions: true` takes the instance OUT of the
 * API-billed set (it counts again); `false` puts it in. Absent vs present
 * follows the same merge convention as subscription prices — this function
 * is the one write the Usage page issues.
 */
export async function setInstanceUsesSubscriptions(instanceId, usesSubscriptions, options) {
  if (!isInstanceId(instanceId)) return getApiBilledInstanceIds();
  const next = await updateSettingsWith((current) => {
    const ids = new Set(normalizeApiBilledInstanceIds(current?.[SETTINGS_KEY]));
    if (usesSubscriptions) ids.delete(instanceId);
    else ids.add(instanceId);
    return { ...current, [SETTINGS_KEY]: normalizeApiBilledInstanceIds([...ids]) };
  }, options);
  return normalizeApiBilledInstanceIds(next?.[SETTINGS_KEY]);
}

export { SETTINGS_KEY as USAGE_API_BILLED_SETTINGS_KEY, MAX_IDS as MAX_API_BILLED_IDS };
