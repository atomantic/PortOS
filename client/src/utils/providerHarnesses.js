/**
 * The agent programs PortOS drives, as the browser needs to name them.
 *
 * Read straight off `PROVIDER_HARNESSES` in `server/lib/providerHarnesses.js`
 * through `harnessById`, so a harness added to the registry is named here
 * without a second edit. Only the label is read: the registry's other columns
 * are decided server-side and arrive on the wire already resolved — `matches`
 * classifies a provider RECORD (the browser is handed a `harnessId`), `modes`
 * is already reflected by the routes a binding actually owns, and `protocol`
 * is a transport decision no picker makes.
 */

import {
  DIRECT_HARNESS_ID,
  PROVIDER_HARNESS_IDS,
  harnessById,
  harnessForProvider,
} from '../../../server/lib/providerHarnesses.js';

/**
 * What to call a binding's harness.
 *
 * `null` is the DIRECT API case and has a name of its own — it is a real
 * binding with a real route, not a missing value. An id this build does not
 * know is shown verbatim rather than hidden: an unmapped harness stays a
 * visible legacy route, which is exactly what the graph promises.
 */
export const harnessLabel = (harnessId) => {
  if (harnessId === null || harnessId === undefined) return 'Direct API';
  return harnessById(harnessId)?.label || harnessId;
};

/** The group a preset with no recognizable harness lands in. */
export const OTHER_HARNESS_GROUP = 'other';

/**
 * The harness a preset record runs on, for GROUPING: a derived preset (#7565)
 * names it outright; a legacy preset is classified from its command/type the
 * same way the server does (`harnessForProvider`), so the two never disagree
 * on which group a record belongs to. `null` when neither applies.
 */
export const providerHarnessId = (provider) =>
  provider?.harnessId ?? harnessForProvider(provider)?.id ?? null;

/**
 * Presets bucketed by harness for the preset-first `ProviderModelSelector`
 * (#7566): one `{ harnessId, label, providers }` per harness in registry
 * order, `direct` (API providers) after the agent harnesses, and a final
 * "Other" bucket for records no harness claims. Empty buckets are omitted and
 * each record's position within its bucket is the input order, so a caller's
 * own ordering survives the grouping.
 *
 * @param {object[]} providers
 * @returns {{harnessId: string, label: string, providers: object[]}[]}
 */
export const groupProvidersByHarness = (providers) => {
  const buckets = new Map();
  for (const provider of Array.isArray(providers) ? providers : []) {
    const harnessId = providerHarnessId(provider) ?? OTHER_HARNESS_GROUP;
    if (!buckets.has(harnessId)) buckets.set(harnessId, []);
    buckets.get(harnessId).push(provider);
  }
  const order = [
    ...PROVIDER_HARNESS_IDS.filter((id) => id !== DIRECT_HARNESS_ID),
    DIRECT_HARNESS_ID,
    ...[...buckets.keys()].filter((id) => !PROVIDER_HARNESS_IDS.includes(id) && id !== OTHER_HARNESS_GROUP),
    OTHER_HARNESS_GROUP,
  ];
  return order
    .filter((harnessId) => buckets.has(harnessId))
    .map((harnessId) => ({
      harnessId,
      label: harnessId === OTHER_HARNESS_GROUP ? 'Other' : harnessLabel(harnessId),
      providers: buckets.get(harnessId),
    }));
};
