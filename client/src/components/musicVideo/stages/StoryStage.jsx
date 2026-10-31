import { useState } from 'react';
import StageSection from '../StageSection.jsx';
import StoryboardLinkPanel, { useStoryboardLink } from '../StoryboardLinkPanel.jsx';
import TreatmentPanel from '../TreatmentPanel.jsx';
import StoryDirection from './StoryDirection.jsx';
import StoryWorkbench from '../StoryWorkbench.jsx';

export default function StoryStage({ board, active = true }) {
  const { project, treatment, locked } = board;
  const { linkStoryboard, linkError } = useStoryboardLink(board);
  const [editingInputs, setEditingInputs] = useState(false);
  const [boardRevision, setBoardRevision] = useState(0);
  return <div className="min-w-0 space-y-3">
    <StoryWorkbench project={project} disabled={locked || board.storySavePending || editingInputs} onProject={board.patchStoryProject}
      onBoardChanged={() => setBoardRevision((n) => n + 1)} active={active} />
    <div onFocusCapture={(event) => { if (event.target.matches('input, textarea, select')) setEditingInputs(true); }}
      onBlurCapture={(event) => { if (event.target.matches('input, textarea, select')) setEditingInputs(false); }}>
    <StageSection id="mv-story-direction" title="Story direction" defaultOpen>
      <StoryDirection board={board} />
    </StageSection>
    <StageSection id="mv-setup-treatment" title="Treatment brief" summary="Premise, emotion and constraints for the shot planner">
      <TreatmentPanel key={`story-treatment-${project.id}`} project={project} treatment={treatment} part="brief"
        storyboardApproved={!!board.productionReadiness?.storyboard?.approved} />
    </StageSection>
    </div>
    <StageSection id="mv-story-storyboard" title="Storyboard" summary={project.storyboardId ? 'Linked' : 'Plan beats and panels'}>
      <StoryboardLinkPanel project={project} onLink={linkStoryboard} refreshKey={boardRevision}
        openPath={`/music-video/${encodeURIComponent(project.id)}/board`} />
      {linkError && <p role="alert" className="text-xs text-port-error">{linkError}</p>}
    </StageSection>
  </div>;
}
