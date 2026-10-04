import AutopilotPanel from '../AutopilotPanel.jsx';
import StageSection from '../StageSection.jsx';
import { GenerationActions } from '../ProjectActionGroups.jsx';

/**
 * Produce: the autopilot (brief, allowed routes, generation and spend caps,
 * the run log) and the manual "generate what's missing" frame and clip
 * buttons. Which image and video services they render on is a project
 * option, set in Setup.
 */
export default function ProduceStage({ board }) {
  const { project, locked, production, videoSettings, sceneMedia, kickoff } = board;
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <AutopilotPanel
        key={`autopilot-${project.id}`}
        project={project}
        production={production}
        readiness={board.productionReadiness}
        onSave={board.saveAutomation}
        onKickoff={board.onKickoff}
        onCancelKickoff={kickoff.running ? kickoff.cancel : undefined}
        kickoffBusy={board.busy.analyzing || board.busy.planning || kickoff.running}
        kickoffStep={kickoff.stepLabel}
        kickoffBlockedReason={board.autopilotBlockedReason}
      />
      <StageSection title="Generation" defaultOpen summary="Generate the frames and clips that are missing">
        <GenerationActions project={project} videoSettings={videoSettings} sceneMedia={sceneMedia} onEditServices={() => board.goToStage('setup', 'mv-setup-options')} />
      </StageSection>
    </fieldset>
  );
}
