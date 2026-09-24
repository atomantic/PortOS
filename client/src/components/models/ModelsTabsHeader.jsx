import { useLocation } from 'react-router';
import {
  getSectionNavTabForPath,
  getSectionNavTabs,
} from '../../../../server/lib/navManifest.js';
import SectionTabsHeader from '../ui/SectionTabsHeader';

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
// The manifest owns this list. Keep the export for page tests and callers that
// need to enumerate the section, but never hand-maintain a second route list.
export const TABS = getSectionNavTabs('Models');

const activeTabForPath = (pathname, fallback) => (
  getSectionNavTabForPath('Models', pathname)?.id || fallback
);

export function ModelsSectionLayout({ children }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );
}

export default function ModelsTabsHeader({ activeTab }) {
  const { pathname } = useLocation();
  const resolvedActiveTab = activeTabForPath(pathname, activeTab);

  return <SectionTabsHeader activeTab={resolvedActiveTab} fallbackSection="Models" />;
}
