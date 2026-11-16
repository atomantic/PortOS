// The one way a tabbed page or section builds its tab bar from the nav manifest.
//
// `buildPageNavTabs(manifestTabs, presentation, pageName)` merges `getPageNavTabs(group)` (nav-manifest owns id/label/order) with a page-owned presentation map (icon, layout flags such as `fullBleed`) and throws at import time when a manifest tab has no entry;
// `buildSectionNavTabs(sectionTabs, presentation, section)` does the same for `getSectionNavTabs(section)`, resolving icons by path out of `NAV_PRESENTATION`.
//
// `server/lib/navManifest.js` is the single registry of navigable destinations, so a page must not restate tab ids/labels/order locally: that second list drifts, and a tab that exists only there is unreachable from ⌘K and voice `ui_navigate`.
// A missing presentation entry throws at module load rather than rendering an iconless tab: a page that can't render its own nav is a build error.

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

/**
 * The same merge for the SECTION axis (`getSectionNavTabs(section)`), whose tabs are sidebar destinations, so icons come from the sidebar's own registry and a section's sub-nav can never disagree with its sidebar row.
 * Missing icon throws: on a phone the bar collapses to icons, and ONE tab without one silently demotes the whole section to the `<select>` the product rejected (see TabPills' `mobileCompact`).
 * @param {Array<{id: string, to: string}>} sectionTabs from `getSectionNavTabs(section)`
 * @param {Record<string, {icon?: Function}>} presentation path-keyed, i.e. NAV_PRESENTATION
 * @param {string} section used in the drift error, e.g. Settings
 */
export const buildSectionNavTabs = (sectionTabs, presentation, section) => (
  sectionTabs.map((tab) => {
    const icon = presentation[tab.to]?.icon;
    if (!icon) throw new Error(`${section}: no nav presentation icon for ${tab.to}`);
    return { ...tab, icon };
  })
);

export default buildPageNavTabs;
