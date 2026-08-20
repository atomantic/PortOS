/**
 * Provider prerequisites, probed.
 *
 * `lib/providerPrerequisites.js` decides what a provider is missing given the
 * facts; this module supplies the facts (the CLI-runtime probe) and exposes the
 * two shapes PortOS needs:
 *
 *   - `getProviderPrerequisiteMap(providers)` — async, awaits the (TTL-cached)
 *     runtime probe. Used to decorate `GET /api/providers` so the AI Providers
 *     page reads the same answer the router uses instead of deriving its own.
 *   - `prerequisitesMetForRouting(provider, providers)` — SYNC, for the
 *     fallback-provider chain in `aiToolkit/providerStatus.js`, which is a
 *     synchronous decision. Reads whatever the probe has already cached and
 *     kicks a background refresh when that is cold.
 *
 * The sync path is deliberately permissive, twice over. An un-probed runtime
 * yields no finding, so the FIRST fallback pick after boot routes exactly as it
 * did before and the refresh it triggers makes every later pick accurate —
 * never the other way round, because a cold cache must not take every CLI
 * provider out of the chain. And it acts only on `ROUTING_BLOCKING_CODES` (the
 * missing binary), not on the credential findings the card also shows.
 *
 * No LLM call is made here. Probing a CLI is a `--version` spawn, so this is
 * safe under the no-cold-bootstrap policy in CLAUDE.md.
 */

import { blocksRouting, describeMissingPrerequisites, providerPrerequisites, providerRuntimeKey } from '../lib/providerPrerequisites.js';
import { getProviderRuntime, getProviderRuntimeStatuses, peekProviderRuntimeStatuses } from './providerRuntimeInstaller.js';

/**
 * Does the sibling `orcarouter` API provider hold the key an OpenCode
 * OrcaRouter wrapper inherits at spawn time?
 *
 * `null` (cannot tell) when there is no provider collection to look in —
 * distinct from `false` ("looked, and the sibling has no key"), which is what a
 * present-but-keyless or deleted sibling gives. Accepts a raw map (keyed by id)
 * or a sanitized array.
 */
const orcaRouterKeyState = (providers) => {
  if (!providers || typeof providers !== 'object') return null;
  const entries = Array.isArray(providers) ? providers : Object.values(providers);
  // An EMPTY collection is "nothing loaded", not "the sibling is gone" — the
  // same `null`-vs-`false` distinction the whole module runs on.
  if (entries.length === 0) return null;
  const sibling = entries.find((p) => p?.id === 'orcarouter');
  return sibling?.hasApiKey === true || Boolean(sibling?.apiKey);
};

const forProvider = (provider, runtimes, orcaRouterKeySet) => providerPrerequisites(provider, {
  // `undefined` (no entry in the map) is NOT PROBED — normalize it to the
  // module's `null` sentinel rather than letting it fall through as a value.
  runtime: runtimes?.[providerRuntimeKey(provider) ?? ''] ?? null,
  orcaRouterKeySet,
});

/**
 * `{ [providerId]: { met, missing } }` for a whole provider collection, one
 * runtime probe for the batch.
 * @param {Array<object>} providers — raw or sanitized provider records
 */
export async function getProviderPrerequisiteMap(providers) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length === 0) return {};
  const runtimes = await getProviderRuntimeStatuses();
  const orcaRouterKeySet = orcaRouterKeyState(list);
  return Object.fromEntries(list.map((provider) => [provider.id, forProvider(provider, runtimes, orcaRouterKeySet)]));
}

// Coalesced background refresh for the sync path — one probe in flight at a
// time, so a failure storm picking a fallback per failed run doesn't fan out a
// `--version` spawn per CLI per run.
let refreshInFlight = null;
const refreshRuntimesInBackground = () => {
  if (refreshInFlight) return;
  refreshInFlight = getProviderRuntimeStatuses()
    .catch((err) => console.error(`❌ Provider runtime probe failed: ${err.message}`))
    .finally(() => { refreshInFlight = null; });
};

/**
 * Can this provider run right now, as far as the already-probed facts say?
 *
 * The gate the fallback chain uses. Returns `true` for anything not KNOWN to be
 * un-runnable — see the sentinel note above, and `ROUTING_BLOCKING_CODES` for
 * why routing acts on a NARROWER set of findings than the card displays. Logs
 * the one line that explains a skip, which is the whole point of the change: a
 * run that used to die on `spawn codex ENOENT` now says which binary is absent
 * and moves on to the next candidate.
 *
 * @param {object} provider
 * @param {object|Array} providers — the sibling collection (for inherited keys)
 * @returns {boolean}
 */
export function prerequisitesMetForRouting(provider, providers) {
  const runtimes = peekProviderRuntimeStatuses();
  const key = providerRuntimeKey(provider);
  // Only for a binary PortOS's runtime table actually covers — a custom command
  // will never appear in the probe's answer, and re-requesting it per fallback
  // pick would be a refresh that can never succeed.
  if (key && !runtimes[key] && getProviderRuntime(key)) refreshRuntimesInBackground();
  const { missing } = forProvider(provider, runtimes, orcaRouterKeyState(providers));
  if (!blocksRouting(missing)) return true;
  console.log(`⛔ Skipping fallback ${provider?.id || 'provider'}: ${describeMissingPrerequisites(missing)}`);
  return false;
}

/** Test-only: drop the in-flight refresh handle so a suite starts clean. */
export function __resetPrerequisiteRefresh() {
  refreshInFlight = null;
}
