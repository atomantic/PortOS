import RouteTabsHeader from '../ui/RouteTabsHeader';

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
// Playground keeps its own `/local-llm/playground` path — it predates this
// section and the path is in ⌘K history — but it renders this header too, so
// selecting it does not strand the user outside the tab bar.
//
// Keep this list alphabetical by label, matching the sidebar convention.
// RouteTabsHeader collapses a list this long to a `<select>` under `sm` on its
// own — no per-section flag to remember.
export const TABS = [
  { id: '3d', label: '3D', to: '/models/3d' },
  { id: 'code-reviewers', label: 'Code Reviewers', to: '/models/code-reviewers' },
  { id: 'embeddings', label: 'Embeddings', to: '/models/embeddings' },
  { id: 'harnesses', label: 'Harnesses', to: '/models/harnesses' },
  { id: 'llms', label: 'LLMs', to: '/models/llms' },
  { id: 'loras', label: 'LoRAs', to: '/models/loras' },
  { id: 'media', label: 'Media', to: '/models/media' },
  { id: 'performance', label: 'Performance', to: '/models/performance' },
  { id: 'playground', label: 'Playground', to: '/local-llm/playground' },
  { id: 'status', label: 'Status', to: '/models/status' },
  { id: 'training', label: 'Training', to: '/models/training' },
];

export default function ModelsTabsHeader({ activeTab }) {
  return <RouteTabsHeader tabs={TABS} activeTab={activeTab} ariaLabel="Models sections" />;
}
