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

/**
 * The same merge for the SECTION axis (`getSectionNavTabs(section)`), whose tabs
 * are sidebar destinations. Their icons therefore come from the sidebar's own
 * registry rather than a page-owned map — one registry, so a section's sub-nav
 * and its sidebar row can never disagree about what a destination looks like.
 *
 * Missing icon throws, for the reason `buildPageNavTabs` throws: on a phone the
 * bar collapses to icons, and ONE tab without one silently demotes the whole
 * section to the `<select>` the product rejected (see TabPills' `mobileCompact`).
 *
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
