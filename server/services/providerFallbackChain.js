import { getSettings, settingsEvents, updateSettings } from './settings.js';
import { normalizeFallbackChain, setFallbackChainCache } from '../lib/providerFallbackChainCache.js';

/**
 * The ONE ordered provider fallback list (settings key `providerFallbackChain`).
 *
 * Whichever entry a run started on, the toolkit's `getFallbackProvider` tries
 * the entries after it in order and wraps past the end to the first, so the
 * list replaces the old per-provider `fallbackProvider` links (which could form
 * cycles). An entry names a preset/composite id plus an optional model and
 * effort; the same preset may repeat with different models.
 *
 * The toolkit reads it synchronously, so a module cache is kept coherent from
 * the `settings:updated` event and primed once at boot (disk only, no LLM call).
 */

settingsEvents.on('settings:updated', (settings) => {
  setFallbackChainCache(settings?.providerFallbackChain);
});

export async function initFallbackChain() {
  const cache = setFallbackChainCache((await getSettings()).providerFallbackChain);
  if (cache.length) console.log(`🔗 Provider fallback list loaded (${cache.length} entries)`);
  return cache;
}

export const getFallbackChain = async () => normalizeFallbackChain((await getSettings()).providerFallbackChain);

// `entries` arrive validated by the route (providerFallbackChainBodySchema).
export async function saveFallbackChain({ entries }) {
  const next = normalizeFallbackChain(entries);
  await updateSettings({ providerFallbackChain: next });
  setFallbackChainCache(next);
  return next;
}
