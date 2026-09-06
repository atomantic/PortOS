import { useLocation } from 'react-router';
import { getNavSectionForPath, getSectionNavTabs } from '../../../../server/lib/navManifest.js';
import RouteTabsHeader from './RouteTabsHeader';

/**
 * Shared section child navigation.
 *
 * The route's manifest entry owns the parent section, tab id, label, and
 * destination. Resolving the section from the current path means a page can
 * move between sidebar parents without carrying a second hard-coded header
 * choice along with it. `fallbackSection` keeps standalone test renders and
 * section indexes usable before a concrete tab route is available.
 */
export default function SectionTabsHeader({ activeTab, fallbackSection, tabs }) {
  const { pathname } = useLocation();
  const section = getNavSectionForPath(pathname) || fallbackSection;
  const sectionTabs = tabs || (section ? getSectionNavTabs(section) : []);

  if (!section || sectionTabs.length === 0) return null;

  return (
    <RouteTabsHeader
      tabs={sectionTabs}
      activeTab={activeTab}
      ariaLabel={`${section} sections`}
    />
  );
}
