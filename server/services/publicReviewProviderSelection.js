/**
 * Public-review provider selection.
 *
 * A pr-reviewer stage declares the POSTURE it needs (`no-tool` for the
 * screening/eligibility stages, `sandboxed-actions` for the optional final
 * review). It never names a vendor. This module turns that posture into a
 * concrete provider by intersecting the install's own enabled AI providers
 * with the vendor rows that declare a maintained recipe for the posture.
 *
 * That indirection is the point: an install with only grok, only a local
 * Claude wrapper, or only codex configures the same three stages. Adding a
 * vendor recipe in `providerVendors.js` makes it selectable everywhere at once
 * — here, in the schedule UI, and at spawn time — with no list of vendor names
 * to keep in sync.
 *
 * Ordinary provider fallback is deliberately NOT reused: falling back off an
 * eligible provider onto an ineligible one would run untrusted public content
 * through a provider with no enforced posture. A stage with no eligible
 * provider fails closed instead.
 */

import { getAllProviders } from './providers.js';
import { isProviderAvailable } from './providerStatus.js';
import {
  publicReviewCapableVendorIds,
  publicReviewPostureForProfile,
  supportsPublicReviewPosture,
  PUBLIC_REVIEW_ACTIONS_POSTURE,
} from '../lib/providerVendors.js';

/** The posture a task's execution profile requires, or null for a normal task. */
export function publicReviewPostureForTask(task) {
  return publicReviewPostureForProfile(task?.metadata?.executionProfile);
}

const isEnabled = (provider) => provider?.enabled !== false;

/**
 * Every configured provider that could run `posture` on this install, in the
 * provider list's own order. `enabled: false` providers are excluded — the
 * user has switched them off — but momentarily-unavailable ones are kept so a
 * rate-limited provider still shows as a legal choice in the picker.
 *
 * @param {string} posture
 * @param {{ providers?: object[] }} [options]
 * @returns {Promise<object[]>}
 */
export async function eligiblePublicReviewProviders(posture, { providers = null } = {}) {
  const list = providers || (await getAllProviders()).providers || [];
  return list.filter((provider) => (
    isEnabled(provider)
    && supportsPublicReviewPosture(provider, posture)
  ));
}

/**
 * Resolve the provider a public-review stage should run on.
 *
 * Preference order — a pin the user set on the stage wins whenever it is still
 * eligible, then the install's active provider, then the first eligible
 * provider that is currently available, then the first eligible provider at
 * all (so a stage stays configured through a transient rate limit rather than
 * silently swapping vendors).
 *
 * @param {{ posture: string, pinnedProviderId?: string|null, activeProviderId?: string|null }} args
 * @returns {Promise<{ ok: true, provider: object, pinHonored: boolean }
 *   | { ok: false, code: string, error: string }>}
 */
export async function resolvePublicReviewProvider({ posture, pinnedProviderId = null, activeProviderId = null } = {}) {
  if (!posture) return { ok: false, code: 'public-review-posture-missing', error: 'No public-review posture requested' };
  const { providers = [], activeProvider } = await getAllProviders();
  const eligible = await eligiblePublicReviewProviders(posture, { providers });
  if (eligible.length === 0) {
    return {
      ok: false,
      code: 'public-review-no-eligible-provider',
      error: posture === PUBLIC_REVIEW_ACTIONS_POSTURE
        ? `No enabled CLI or TUI provider on this install can run the '${posture}' public-review stage. Enable one in Settings > Providers.`
        : `No enabled AI provider on this install has a maintained '${posture}' public-review posture. Add or enable one of these CLI providers in Settings > Providers: ${publicReviewCapableVendorIds(posture).join(', ')}.`,
    };
  }
  const pinned = pinnedProviderId ? eligible.find((provider) => provider.id === pinnedProviderId) : null;
  if (pinned) return { ok: true, provider: pinned, pinHonored: true };

  const activeId = activeProviderId || activeProvider?.id || activeProvider || null;
  const active = activeId ? eligible.find((provider) => provider.id === activeId) : null;
  const chosen = active
    || eligible.find((provider) => isProviderAvailable(provider.id))
    || eligible[0];
  return { ok: true, provider: chosen, pinHonored: false };
}
