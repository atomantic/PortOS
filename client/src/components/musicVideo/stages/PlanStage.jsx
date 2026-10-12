import BeatTimeline from '../BeatTimeline.jsx';
import TreatmentPanel, { treatmentSummary } from '../TreatmentPanel.jsx';
import StageSection from '../StageSection.jsx';
import { PlanActions } from '../ProjectActionGroups.jsx';
import ShotPacingFields from '../ShotPacingFields.jsx';

/**
 * Plan: the shot list before any shot is made — planning tools, the
 * treatment (the brief the planner reads, then per-shot
 * direction) and the beat timeline. Each shot's still, clip and locks are on
 * Shots.
 */
export default function PlanStage({ board }) {
  const { project, locked, busy, treatment } = board;
  const scenes = project.scenes || [];
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <StageSection title="Planning tools">
        <PlanActions project={project} busy={busy} onPlan={board.onPlan} onAutoArrange={board.onAutoArrange} />
        <ShotPacingFields project={project} onEditLocal={board.editProjectLocal} onSave={board.saveProjectFields} />
      </StageSection>

      {/* The brief feeds the shot planner; the direction is applied per shot once they exist. */}
      <StageSection id="mv-board-treatment" title="Treatment" summary={scenes.length ? treatmentSummary(project) : 'Write the brief the shot planner follows'}>
        <div id="mv-setup-treatment">
          <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment}
            storyboardApproved={!!board.productionReadiness?.storyboard?.approved} />
        </div>
      </StageSection>

      {project.audioAnalysis && scenes.length > 0 && (
        <StageSection title="Beat timeline">
        <BeatTimeline audioAnalysis={project.audioAnalysis} scenes={scenes} lyricCues={project.lyricCues} narrativeEvents={project.composition?.narrativeEvents}
          onSeek={(startSec) => board.seekToScene({ startSec })} onCommit={board.commitSceneTiming} />
        </StageSection>
      )}
    </fieldset>
  );
}
