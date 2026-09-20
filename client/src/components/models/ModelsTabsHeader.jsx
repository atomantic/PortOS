import { NavLink, useLocation } from 'react-router';
import {
  getSectionNavGroups,
  getSectionNavTabForPath,
  getSectionNavTabs,
} from '../../../../server/lib/navManifest.js';
import SectionTabsHeader from '../ui/SectionTabsHeader';
import { buildSectionNavTabs } from '../../lib/pageNavTabs.js';
import { NAV_PRESENTATION } from '../../lib/navPresentation.js';
import { useSidebarContext } from '../SidebarContext.jsx';

// Shared sub-nav for the top-level Models section.
//
// Model management used to be one long Settings tab: memory residency, measured
// assessments, backend install/switch, the llama.cpp launcher, and the install
// catalog all stacked on `/settings/local-llm`. Splitting them across their own
// section gives each a URL you can land on (and reach from ⌘K / voice) instead
// of a scroll position on a page about something else.
//
// The section now covers every KIND of model this install manages, not just
// text (#4728): image/video checkpoints, LoRAs and their training datasets,
// embedding models, and the on-device image-to-3D runtimes moved in from Create,
// Settings and Dev Tools. What stayed behind is output, not weights — Three.js
// Models is a gallery of generated meshes, and `/3d` is the render flow that
// consumes the runtimes listed here.
//
// Several destinations keep their legacy paths (`/ai/*`, `/devtools/*`, and
// `/local-llm/playground`) but render this header too, so selecting any Models
// destination does not strand the user outside the tab bar.
//
// The manifest owns this list. Keep the export for page tests and callers that
// need to enumerate the section, but never hand-maintain a second route list.
export const TABS = getSectionNavTabs('Models');
export const GROUPS = getSectionNavGroups('Models');

const PRESENTED_TABS = buildSectionNavTabs(TABS, NAV_PRESENTATION, 'Models');
const PRESENTATION_BY_ID = new Map(PRESENTED_TABS.map((tab) => [tab.id, tab]));

const activeTabForPath = (pathname, fallback) => (
  getSectionNavTabForPath('Models', pathname)?.id || fallback
);

export function ModelsDesktopNavigator({ activeTab }) {
  const { pathname } = useLocation();
  const { collapsed, desktop } = useSidebarContext();
  const resolvedActiveTab = activeTabForPath(pathname, activeTab);

  if (!desktop || !collapsed) return null;

  return (
    <nav
      aria-label="Models destinations"
      className="hidden lg:flex w-56 shrink-0 flex-col border-r border-port-border bg-port-card/40 overflow-y-auto px-3 py-4"
    >
      <h2 className="sr-only">Models destinations</h2>
      {GROUPS.map((group) => (
        <div key={group.label} className="mb-4 last:mb-0">
          <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            {group.label}
          </h3>
          <div className="space-y-0.5">
            {group.tabs.map((tab) => {
              const presented = PRESENTATION_BY_ID.get(tab.id);
              const Icon = presented.icon;
              const active = tab.id === resolvedActiveTab;
              return (
                <NavLink
                  key={tab.id}
                  to={tab.to}
                  end
                  aria-current={active ? 'page' : undefined}
                  className={`flex min-h-[44px] items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent ${
                    active
                      ? 'bg-port-accent/15 text-port-accent font-medium'
                      : 'text-gray-400 hover:bg-port-border/50 hover:text-white'
                  }`}
                >
                  <Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 break-words leading-snug">{tab.label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export default function ModelsTabsHeader({ activeTab, desktop = true }) {
  const { pathname } = useLocation();
  const resolvedActiveTab = activeTabForPath(pathname, activeTab);

  return (
    <>
      {desktop && <ModelsDesktopNavigator activeTab={resolvedActiveTab} />}
      <div className="lg:hidden">
        <SectionTabsHeader activeTab={resolvedActiveTab} fallbackSection="Models" />
      </div>
    </>
  );
}
