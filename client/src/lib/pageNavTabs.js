// The one way a page builds its own tab bar from the nav manifest.
//
// `server/lib/navManifest.js` is the single registry of navigable destinations,
// so a tabbed page must not restate its tab ids, labels or order in a local
// array — that second list drifts, and a tab that exists only there is
// unreachable from ⌘K and voice `ui_navigate`. Instead the page declares
// `tabGroup: '<group>'` on each manifest entry and pairs `getPageNavTabs(group)`
// with a PRESENTATION map holding only what the manifest has no business
// knowing: the icon, and any page-only layout flag (`fullBleed`, …).
//
// A manifest tab with no presentation entry throws HERE, at module load, rather
// than rendering an iconless tab or silently dropping it — a page that can't
// render its own nav is a build error, not a runtime degradation.

/**
 * @param {Array<{id: string}>} manifestTabs from `getPageNavTabs(group)`
 * @param {Record<string, object>} presentation per-tab-id icon/layout, page-owned
 * @param {string} pageName used in the drift error, e.g. "Wiki"
 */
export const buildPageNavTabs = (manifestTabs, presentation, pageName) => (
  manifestTabs.map((tab) => {
    const tabPresentation = presentation[tab.id];
    if (!tabPresentation) throw new Error(`${pageName}: no tab presentation for manifest tab "${tab.id}"`);
    return { ...tab, ...tabPresentation };
  })
);

export default buildPageNavTabs;
