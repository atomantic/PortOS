import PreviewDock from './PreviewDock.jsx';
import { listPreviewSources } from '../../lib/musicVideoStages.js';

const LEAD_SOURCE = { review: 'drafts', produce: 'storyboard', editor: 'storyboard', setup: 'lyrics', previz: 'previz' };

export default function WorkspacePreviewDock({
  selected, stageProject, finalVideo, activeStage, setup, seekRequest, dockCollapsed,
  setDockCollapsed, dockExpanded, setDockExpanded, playerFirst, editShot, replaceProject,
  blender, songClockRef, compact,
}) {
  const previewSources = listPreviewSources(stageProject, { finalVideo, leadWith: LEAD_SOURCE[activeStage] || 'final' });
  return (
    <PreviewDock
      project={selected}
      sources={previewSources}
      audioUrl={setup.audioUrl}
      seekRequest={seekRequest}
      collapsed={dockCollapsed ?? !playerFirst}
      onToggleCollapsed={() => setDockCollapsed(!(dockCollapsed ?? !playerFirst))}
      expanded={dockExpanded}
      onToggleExpanded={!playerFirst ? () => setDockExpanded((expanded) => !expanded) : undefined}
      onEditShot={editShot}
      onProject={replaceProject}
      blender={blender}
      clockRef={songClockRef}
      compact={compact}
      controlsBeside={compact}
    />
  );
}
