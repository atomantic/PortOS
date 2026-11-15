import { useLocation } from 'react-router';
import { getNavSectionForPath, getSectionNavGroups, getSectionNavTabs } from '../../../../server/lib/navManifest.js';
import SectionTabsHeader from '../ui/SectionTabsHeader';
import GroupedRouteTabsHeader from '../ui/GroupedRouteTabsHeader';
import { buildSectionNavTabs } from '../../lib/pageNavTabs.js';
import { NAV_PRESENTATION } from '../../lib/navPresentation.js';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures.js';

// Backward-compatible wrapper for the shared section child nav. Settings.jsx
// hosts the in-Settings tabs (general/backup/etc.) and standalone pages such as
// Prompts host themselves; the current route resolves the actual parent section
// so a moved page does not keep rendering the old parent's tabs.
//
// The manifest owns this list. Keep the export for Settings tests and callers
// that enumerate the section, but never hand-maintain a second route list.
export const TABS = getSectionNavTabs('Settings');

export default function SettingsTabsHeader({ activeTab }) {
  const { pathname } = useLocation();
  const { isFeatureEnabled } = useInstanceFeatures();
  const section = getNavSectionForPath(pathname) || 'Settings';
  const groups = getSectionNavGroups(section)
    .map(({ label, tabs }) => ({
      label,
      tabs: buildSectionNavTabs(tabs.filter((tab) => isFeatureEnabled(tab.feature)), NAV_PRESENTATION, section),
    }))
    .filter((group) => group.tabs.length > 0);
  if (groups.length === 0) {
    const visibleTabs = getSectionNavTabs(section).filter((tab) => isFeatureEnabled(tab.feature));
    return <SectionTabsHeader tabs={visibleTabs} activeTab={activeTab} fallbackSection={section} />;
  }
  return <GroupedRouteTabsHeader groups={groups} activeTab={activeTab} ariaLabel={`${section} sections`} />;
}
