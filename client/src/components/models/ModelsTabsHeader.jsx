import { getSectionNavTabs } from '../../../../server/lib/navManifest.js';
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
// Providers (`/ai`), Usage (`/devtools/usage`) and Playground
// (`/local-llm/playground`) keep their legacy paths, but render this header too,
// so selecting any Models destination does not strand the user outside the tab bar.
//
// The manifest owns this list. Keep the export for page tests and callers that
// need to enumerate the section, but never hand-maintain a second route list.
export const TABS = getSectionNavTabs('Models');

export default function ModelsTabsHeader({ activeTab }) {
  return <SectionTabsHeader activeTab={activeTab} fallbackSection="Models" />;
}
