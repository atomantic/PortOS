import BeatTimeline from '../BeatTimeline.jsx';
import TreatmentPanel, { treatmentSummary } from '../TreatmentPanel.jsx';
import StageSection from '../StageSection.jsx';
import { PlanActions } from '../ProjectActionGroups.jsx';
import ShotPacingFields from '../ShotPacingFields.jsx';
import StoryboardLinkPanel from '../StoryboardLinkPanel.jsx';
import PlanShotList from '../PlanShotList.jsx';

/**
 * Plan: the timing check before any shot is made. The shot list reads every
 * shot against the song (time, panel, lyric, action) with its problems on its
 * own row; the beat timeline shows the cuts over the waveform and lyrics. The
 * tools that write the plan (AI Plan, pacing, fitting the linked storyboard)
 * sit folded at the top, open while there are no shots; the treatment is
 * folded at the end. Plan has no player: each shot's still, clip and locks are
 * on Shots, which a row opens.
 */
export default function PlanStage({ board }) {
  const { project, locked, busy, treatment } = board;
  const scenes = project.scenes || [];
  return (
    <div className="min-w-0 space-y-3">
      <StageSection id="mv-board-plan" title="Planning tools" defaultOpen={scenes.length === 0}
        summary={project.storyboardId ? 'AI Plan, pacing, fit storyboard to song' : 'AI Plan, Auto-arrange, pacing'}>
        <fieldset disabled={locked} className="min-w-0 space-y-2">
          <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
          <ShotPacingFields project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
        </fieldset>
        <div id="mv-board-storyboard" className="min-w-0 space-y-1">
          <h4 className="text-sm font-medium">Fit storyboard to song</h4>
          <StoryboardLinkPanel project={project} mode="fit" onStory={() => board.goToStage('story')} fitDisabled={locked || busy.planning || busy.arranging}
            onFitted={(saved) => board.editProjectLocal(saved)} />
        </div>
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
