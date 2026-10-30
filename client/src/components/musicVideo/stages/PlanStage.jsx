import { useState } from 'react';
import { useParams } from 'react-router';
import BeatTimeline from '../BeatTimeline.jsx';
import TreatmentPanel, { treatmentSummary } from '../TreatmentPanel.jsx';
import StageSection from '../StageSection.jsx';
import { PlanActions } from '../ProjectActionGroups.jsx';
import ShotPacingFields from '../ShotPacingFields.jsx';
import StoryboardLinkPanel, { useStoryboardLink } from '../StoryboardLinkPanel.jsx';
import StoryboardFitPanel from '../StoryboardFitPanel.jsx';
import PlanShotList from '../PlanShotList.jsx';
import StoryboardEditor from '../../storyboards/StoryboardEditor';

/**
 * Storyboard: the video's linked Create › Storyboards board, edited in place
 * (beats, panels, sketch frames, the animatic), with its open panel in the URL
 * at `/music-video/:projectId/board/panel/:panelId`. With no board linked yet
 * the step offers to start one. Below it, the timing check: the shot list
 * reads every timed shot against the song, the beat timeline shows the cuts
 * over the waveform, and the tools that write the shots (AI Plan, pacing, Fit
 * to song) sit folded. The treatment is folded at the end.
 */
export default function PlanStage({ board }) {
  const { project, locked, busy, treatment } = board;
  const { panelId } = useParams();
  const scenes = project.scenes || [];
  const linkedId = project.storyboardId || null;
  const [storyboard, setStoryboard] = useState(null);
  const [staleReads, setStaleReads] = useState(0);
  const { linkStoryboard, linkError } = useStoryboardLink(board);
  const shownBoard = storyboard?.id === linkedId ? storyboard : null;
  return (
    <div className="min-w-0 space-y-3">
      {linkedId ? (
        <section id="mv-board-storyboard" aria-label="Storyboard" className="min-w-0">
          <StoryboardEditor key={linkedId} embedded boardId={linkedId} panelId={panelId}
            boardPath={`/music-video/${encodeURIComponent(project.id)}/board`} onBoard={setStoryboard} refreshKey={staleReads} />
        </section>
      ) : (
        <StageSection id="mv-board-storyboard" title="Start the storyboard" defaultOpen
          summary="Beats and sketched panels for the story">
          <StoryboardLinkPanel project={project} onLink={linkStoryboard} />
          {linkError && <p role="alert" className="text-xs text-port-error">{linkError}</p>}
        </StageSection>
      )}

      <StageSection id="mv-board-plan" title="Planning tools" defaultOpen={scenes.length === 0}
        summary={linkedId ? 'AI Plan, pacing, fit storyboard to song' : 'AI Plan, Auto-arrange, pacing'}>
        <fieldset disabled={locked} className="min-w-0 space-y-2">
          <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
          <ShotPacingFields project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
        </fieldset>
        {shownBoard && (
          <div id="mv-board-fit" className="min-w-0 space-y-1">
            <h4 className="text-sm font-medium">Fit storyboard to song</h4>
            <StoryboardFitPanel project={project} board={shownBoard} disabled={locked || busy.planning || busy.arranging}
              onFitted={(saved) => board.editProjectLocal(saved)} onBoardStale={() => setStaleReads((n) => n + 1)} />
          </div>
        )}
      </StageSection>

      <PlanShotList project={project} readiness={board.productionReadiness} onOpenShot={board.onEditShot} />

      {project.audioAnalysis && scenes.length > 0 && (
        <StageSection title="Beat timeline" summary="Drag a cut to move it" defaultOpen>
          <fieldset disabled={locked} className="min-w-0">
            <BeatTimeline audioAnalysis={project.audioAnalysis} scenes={scenes} lyricCues={project.lyricCues} narrativeEvents={project.composition?.narrativeEvents}
              onCommit={board.commitSceneTiming} />
          </fieldset>
        </StageSection>
      )}

      {/* The brief feeds the shot planner; the direction is applied per shot once they exist. */}
      <fieldset disabled={locked} className="min-w-0">
        <StageSection id="mv-board-treatment" title="Treatment direction" summary={scenes.length ? treatmentSummary(project) : 'Plan shots to compile their direction'}>
          <div>
            <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment}
              storyboardApproved={!!board.productionReadiness?.storyboard?.approved} part="production" />
          </div>
        </StageSection>
      </fieldset>
    </div>
  );
}
