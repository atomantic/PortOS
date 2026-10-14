/**
 * Process cache of the user's ordered provider fallback list. Kept free of
 * imports so routing code (promptRunner, agent resolution, bootstrap) can read
 * it synchronously without pulling in settings or validation. The settings
 * binding that fills it lives in `services/providerFallbackChain.js`.
 */

let chain = [];

/** Normalize to `[{ providerId, model?, effort? }]`, dropping malformed rows. */
export const normalizeFallbackChain = (entries) => (Array.isArray(entries) ? entries : [])
  .filter((e) => e && typeof e.providerId === 'string' && e.providerId)
  .map(({ providerId, model, effort }) => ({
    providerId,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }));

export const peekFallbackChain = () => chain;

export const setFallbackChainCache = (entries) => {
  chain = normalizeFallbackChain(entries);
  return chain;
};
