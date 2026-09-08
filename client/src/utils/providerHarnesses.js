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

import { harnessById } from '../../../server/lib/providerHarnesses.js';

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
