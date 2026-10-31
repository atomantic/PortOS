import BeatTimeline from './BeatTimeline.jsx';
import TreatmentPanel, { treatmentSummary } from './TreatmentPanel.jsx';
import StageSection from './StageSection.jsx';
import { PlanActions } from './ProjectActionGroups.jsx';
import ShotPacingFields from './ShotPacingFields.jsx';
import PlanShotList from './PlanShotList.jsx';

/**
 * Shot timing on Shots, folded under the board: the shot list read against the
 * song (each shot's problems on its row), the tools that write shots without a
 * storyboard (AI Plan, Auto-arrange, pacing), the beat timeline for dragging
 * cuts, and the treatment direction. The storyboard step stays the story; the
 * shots are timed and finished here.
 */
export default function ShotTimingTools({ board }) {
  const { project, locked, busy, treatment } = board;
  const scenes = project.scenes || [];
  return (
    <StageSection id="mv-board-plan" title="Shot timing" defaultOpen={scenes.length === 0}
      summary="Shot list, AI Plan, pacing, beat timeline, treatment">
      <div className="min-w-0 space-y-3">
        <PlanShotList project={project} readiness={board.productionReadiness} onOpenShot={board.onEditShot} />
        <fieldset disabled={locked} className="min-w-0 space-y-2">
          <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
          <ShotPacingFields project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
        </fieldset>
        {project.audioAnalysis && scenes.length > 0 && (
          <fieldset disabled={locked} className="min-w-0 space-y-1">
            <h4 className="text-sm font-medium">Beat timeline</h4>
            <p className="text-xs text-port-text-muted">Drag a cut to move it.</p>
            <BeatTimeline audioAnalysis={project.audioAnalysis} scenes={scenes} lyricCues={project.lyricCues} narrativeEvents={project.composition?.narrativeEvents}
              onCommit={board.commitSceneTiming} />
          </fieldset>
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
    </StageSection>
  );
}
