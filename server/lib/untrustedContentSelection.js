/** Select the eligible API provider and model for an untrusted-content policy. */

import { ABUSE_GUARD_PAGE_BREADCRUMB } from './navManifest.js';
import { PRIVATE_UNTRUSTED_CONTENT_SOURCES } from './untrustedContentSources.js';

/** The API completion transport offers no tools or execution loop. */
export function isUntrustedContentProvider(provider, source) {
  if (provider?.enabled === false || provider?.type !== 'api' || typeof provider.endpoint !== 'string') return false;
  const endpoint = URL.parse(provider.endpoint);
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return false;
  return !PRIVATE_UNTRUSTED_CONTENT_SOURCES.includes(source)
    || ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase());
}

const PROVIDER_UNAVAILABLE = Object.freeze({ code: 'untrusted-content-provider-unavailable', message: `Configure an enabled text API provider in ${ABUSE_GUARD_PAGE_BREADCRUMB}. Private messages require a local API endpoint. CLI agents and provider fallback are disabled for external content.` });

/** Smallest window automatic selection treats as able to hold a real PR. */
export const MIN_VIABLE_CONTEXT_TOKENS = 16384;

/**
 * Resolve the provider and model an untrusted-content analysis will use.
 *
 * Automatic selection (no explicit provider, no pinned `policy.providerId`)
 * only considers providers that can also resolve a model, so an eligible
 * provider without a default model never shadows a usable one. This is an
 * eligibility rule at selection time, not a fallback after a failed call: a
 * pinned or explicit provider that cannot resolve a model fails closed.
 *
 * When the caller supplies `windowOf(provider, model)` (the same budget ladder
 * the analysis uses), automatic selection also prefers a candidate whose window
 * reaches MIN_VIABLE_CONTEXT_TOKENS, so an unconfigured local endpoint floored
 * at 4096 never shadows a provider that can hold a real PR. If none qualifies
 * the first candidate is kept: single-provider installs behave as before.
 */
export function selectUntrustedContentProvider({ providers, policy, source, provider = null, model = null, windowOf = null }) {
  if (provider || policy.providerId) {
    const selected = provider || (providers || []).find(item => item.id === policy.providerId);
    if (!isUntrustedContentProvider(selected, source)) return PROVIDER_UNAVAILABLE;
    const effectiveModel = model || (provider && provider.id !== policy.providerId ? null : policy.model) || selected.defaultModel;
    return effectiveModel
      ? { provider: selected, model: effectiveModel }
      : { code: 'untrusted-content-model-required', message: `Select an installed text model in ${ABUSE_GUARD_PAGE_BREADCRUMB}.` };
  }
  const eligible = (providers || []).filter(item => isUntrustedContentProvider(item, source));
  if (!eligible.length) return PROVIDER_UNAVAILABLE;
  const candidates = [];
  for (const candidate of eligible) {
    const effectiveModel = model || policy.model || candidate.defaultModel;
    if (effectiveModel) candidates.push({ provider: candidate, model: effectiveModel });
  }
  if (candidates.length) {
    return (windowOf && candidates.find(item => windowOf(item.provider, item.model) >= MIN_VIABLE_CONTEXT_TOKENS)) || candidates[0];
  }
  return { code: 'untrusted-content-model-required', message: `No eligible API provider has a default model. Select an installed text model in ${ABUSE_GUARD_PAGE_BREADCRUMB}.` };
}
