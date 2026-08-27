import { useCallback, useEffect, useState } from 'react';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import * as api from '../services/api';

// Shared read of Settings > Features (`GET /api/settings/features`), with one
// module-level cache so the sidebar, the ⌘K palette, and the Features tab
// collapse to a single fetch per page load.
//
// Change notification rides the EXISTING `INSTANCE_FEATURES_CHANGED` window
// event rather than a second broadcast channel — the engagement-reminder toast
// already publishes on it and three dashboard widgets already listen, so a
// private subscriber list here would have left those halves able to drift.
// A publisher that already holds the server's fresh list passes it as
// `detail.features` to skip the refetch; the `{ featureId, enabled }` shape the
// existing publisher sends still works and simply triggers one.
//
// `null` features means NOT LOADED — deliberately distinct from `[]`, which
// means loaded and this version registers no optional features.
let cached = null;
let inFlight = null;
let inFlightGeneration = null;
// Bumped whenever something newer than an outstanding request lands (a toggle
// publishing the server's fresh list, or an invalidation). A response that read
// the OLD state must not overwrite it just because it resolved later — without
// this, saving a JIRA instance while the initial fetch is still in flight leaves
// the sidebar and ⌘K showing the pre-save answer until a reload.
let generation = 0;

const loadInstanceFeatures = () => {
  if (!inFlight || inFlightGeneration !== generation) {
    const requested = generation;
    const request = api.getInstanceFeatures({ silent: true })
      .then((data) => ({ features: Array.isArray(data?.features) ? data.features : [], error: null }))
      .catch((error) => {
        // Fail OPEN: an unreadable feature list must not blank out navigation.
        console.warn(`⚠️ instance features fetch failed: ${error?.message || error}`);
        return { features: null, error };
      })
      .then((result) => {
        if (inFlight === request) {
          inFlight = null;
          inFlightGeneration = null;
        }
        // Superseded while in flight — hand the caller what IS current instead
        // of the answer it asked for, so no consumer renders the stale one.
        if (requested !== generation) return cached || result;
        cached = result;
        return result;
      });
    inFlight = request;
    inFlightGeneration = requested;
  }
  return inFlight;
};

/**
 * @returns {{
 *   features: Array|null,   // null while loading or after a failed fetch
 *   error: Error|null,
 *   isFeatureEnabled: (featureId: string) => boolean,
 *   reload: () => Promise<void>,
 * }}
 *
 * `isFeatureEnabled` answers for navigation gating:
 *   - loaded  → the stored/auto-resolved value; an unregistered id is enabled
 *               (an unknown gate must never erase a page)
 *   - loading → false, so a gated row appears once rather than flashing away
 *   - errored → true, so a server hiccup shows everything instead of hiding it
 */
export function useInstanceFeatures() {
  const [state, setState] = useState(() => cached || { features: null, error: null });

  useEffect(() => {
    let active = true;
    const sync = (result) => { if (active) setState(result); };

    if (cached) sync(cached); else loadInstanceFeatures().then(sync);

    const onFeaturesChanged = (event) => {
      const features = event?.detail?.features;
      generation += 1;
      if (Array.isArray(features)) {
        cached = { features, error: null };
        sync(cached);
        return;
      }
      cached = null;
      loadInstanceFeatures().then(sync);
    };

    window.addEventListener(INSTANCE_FEATURES_CHANGED, onFeaturesChanged);
    return () => {
      active = false;
      window.removeEventListener(INSTANCE_FEATURES_CHANGED, onFeaturesChanged);
    };
  }, []);

  const { features, error } = state;

  const isFeatureEnabled = useCallback((featureId) => {
    if (!featureId) return true;
    if (error) return true;
    if (features === null) return false;
    const feature = features.find((item) => item?.id === featureId);
    return feature ? feature.enabled !== false : true;
  }, [features, error]);

  // Announced rather than applied locally: after a failed first fetch every
  // consumer is sitting in the fail-open error state, and a retry that updated
  // only the Settings tab would leave the sidebar and ⌘K stale until a reload.
  const reload = useCallback(() => {
    generation += 1;
    cached = null;
    return loadInstanceFeatures().then((result) => {
      if (result.features) publishInstanceFeatures(result.features);
      else setState(result);
    });
  }, []);

  return { features, error, isFeatureEnabled, reload };
}

/**
 * Announce a feature change on the shared channel. Pass the server's fresh
 * `features` list so every listener applies it without a second round-trip.
 */
export const publishInstanceFeatures = (features, { featureId, enabled } = {}) => {
  window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
    detail: { featureId, enabled, features: Array.isArray(features) ? features : undefined },
  }));
};

/**
 * Announce that the state a feature's AUTO-detection reads has changed — the
 * integration pages call this after adding or removing an instance, because the
 * DataDog/JIRA gates are derived from whether one is configured. Carries no
 * feature list, so every listener re-fetches the freshly-resolved answer.
 */
export const invalidateInstanceFeatures = (featureId) => {
  publishInstanceFeatures(null, { featureId });
};

// Test-only: drop the module cache so suites don't leak state between tests.
export const __resetInstanceFeatureCache = () => {
  cached = null;
  inFlight = null;
  inFlightGeneration = null;
  generation += 1;
};
