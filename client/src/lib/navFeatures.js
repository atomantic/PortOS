// The one gate every BROWSE surface applies to the nav manifest.
//
// `GET /api/palette/manifest` ships each entry's optional `feature` tag rather
// than pre-filtering, so the response stays HTTP-cacheable and shared across the
// three consumers that fetch it. The gate is applied here instead, on the client
// that holds the user's live feature state — which is also what makes a toggle
// in Settings > Features take effect without a reload (⌘K and the voice widget
// both cache the manifest for the session).
//
// Gating covers browse surfaces only: the sidebar and ⌘K. A route stays live and
// navigable by URL, bookmark, or voice `ui_navigate`, exactly as a disabled
// feature's page stays reachable when opened directly.

/**
 * @param {Array<{feature?: string}>} navEntries manifest entries
 * @param {(featureId?: string) => boolean} isFeatureEnabled from `useInstanceFeatures`
 */
export const filterNavByFeatures = (navEntries, isFeatureEnabled) => (
  (navEntries || []).filter((entry) => isFeatureEnabled(entry?.feature))
);

export default filterNavByFeatures;
