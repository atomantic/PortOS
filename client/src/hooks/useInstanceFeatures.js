import { useCallback, useSyncExternalStore } from 'react';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import * as api from '../services/api';

// One snapshot and event bridge for every mounted consumer. `null` means not
// loaded (or failed), while [] is a successfully loaded empty feature list.
const INITIAL_STATE = { features: null, error: null };
let snapshot = INITIAL_STATE;
let inFlight = null;
let generation = 0;
const subscribers = new Set();

const getSnapshot = () => snapshot;
const commitSnapshot = (result) => {
  snapshot = result;
  subscribers.forEach((notify) => notify());
};

const loadInstanceFeatures = () => {
  if (!inFlight) {
    const requested = generation;
    const request = api.getInstanceFeatures({ silent: true })
      .then((data) => ({ features: Array.isArray(data?.features) ? data.features : [], error: null }))
      .catch((error) => {
        console.warn(`⚠️ instance features fetch failed: ${error?.message || error}`);
        return { features: null, error };
      })
      .then((result) => {
        if (inFlight === request) inFlight = null;
        // A superseded request never publishes, even while its replacement is
        // pending. Subscribers receive only the current generation's result.
        if (requested === generation) commitSnapshot(result);
      });
    inFlight = request;
  }
  return inFlight;
};

const onFeaturesChanged = (event) => {
  generation += 1;
  inFlight = null;
  const features = event?.detail?.features;
  if (Array.isArray(features)) {
    commitSnapshot({ features, error: null });
  } else {
    commitSnapshot(INITIAL_STATE);
    loadInstanceFeatures();
  }
};

const subscribe = (notify) => {
  if (subscribers.size === 0) {
    window.addEventListener(INSTANCE_FEATURES_CHANGED, onFeaturesChanged);
  }
  subscribers.add(notify);
  if (snapshot === INITIAL_STATE) loadInstanceFeatures();
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      window.removeEventListener(INSTANCE_FEATURES_CHANGED, onFeaturesChanged);
    }
  };
};

const reload = () => {
  generation += 1;
  const requested = generation;
  inFlight = null;
  commitSnapshot(INITIAL_STATE);
  return loadInstanceFeatures().then(() => {
    // Preserve the public success announcement for non-hook event listeners.
    if (requested === generation && snapshot.features) publishInstanceFeatures(snapshot.features);
  });
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
  const { features, error } = useSyncExternalStore(subscribe, getSnapshot);

  const isFeatureEnabled = useCallback((featureId) => {
    if (!featureId) return true;
    if (error) return true;
    if (features === null) return false;
    const feature = features.find((item) => item?.id === featureId);
    return feature ? feature.enabled !== false : true;
  }, [features, error]);

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
 * feature list, so the store re-fetches the freshly-resolved answer once.
 */
export const invalidateInstanceFeatures = (featureId) => {
  publishInstanceFeatures(null, { featureId });
};

// Test-only: drop the module cache so suites don't leak state between tests.
export const __resetInstanceFeatureCache = () => {
  snapshot = INITIAL_STATE;
  inFlight = null;
  generation += 1;
};
