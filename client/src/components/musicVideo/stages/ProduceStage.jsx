import AutopilotPanel from '../AutopilotPanel.jsx';
import StageSection from '../StageSection.jsx';
import { GenerationActions } from '../ProjectActionGroups.jsx';

/**
 * Produce: the autopilot (brief, allowed routes, generation and spend caps,
 * the run log) and the manual generators — frame and clip renderers, and the
 * batch "generate what's missing" buttons.
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
      <StageSection title="Generation" defaultOpen summary="Frame and clip renderers, and generate what is missing">
        <GenerationActions project={project} videoSettings={videoSettings} sceneMedia={sceneMedia} />
      </StageSection>
    </fieldset>
  );
}
