import AutopilotPanel from '../AutopilotPanel.jsx';
import ContactSheetButton from '../ContactSheetButton.jsx';
import HandoffControls from '../HandoffControls.jsx';
import StageSection from '../StageSection.jsx';
import { GenerationActions } from '../ProjectActionGroups.jsx';
import ShotStatusStrip from '../ShotStatusStrip.jsx';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { FOOTAGE_OPTIONAL_MODES } from '../../../lib/musicVideoStages.js';

/**
 * Produce: the autopilot (brief, allowed routes, generation and spend caps,
 * the run log) and the manual "generate what's missing" frame and clip
 * buttons. Which image and video services they render on is a project
 * option, set in Setup.
 */
export default function ProduceStage({ board }) {
  const { project, locked, production, videoSettings, sceneMedia, kickoff, takes } = board;
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
      {(project.scenes || []).length > 0 && (
        <StageSection title="Shot status" defaultOpen summary="Which shots still need work — tap one to open it on the Board">
          <ShotStatusStrip projectId={project.id} scenes={project.scenes} ctx={{
            layered: isLayeredComposition(project),
            footageOptional: FOOTAGE_OPTIONAL_MODES.has(project.composition?.mode || 'concat'),
            lipSyncBackend: videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend,
            songDurationSec: project.audioAnalysis?.durationSec ?? null,
            failed: sceneMedia.failedScenes,
          }} />
        </StageSection>
      )}
      <StageSection title="Generation" defaultOpen summary="Generate the frames and clips that are missing">
        <div className="mb-2 flex justify-end"><ContactSheetButton onOpen={board.openContactSheet} /></div>
        <GenerationActions project={project} videoSettings={videoSettings} sceneMedia={sceneMedia} onEditServices={() => board.goToStage('setup', 'mv-setup-options')} />
      </StageSection>
      <StageSection title="External handoff" summary="Export prompts, import files made in other tools">
        <HandoffControls
          projectId={project.id}
          busy={takes.busy}
          onExport={takes.exportHandoff}
          onExportBundle={takes.exportHandoffBundle}
          onImport={takes.importHandoffFiles}
        />
      </StageSection>
    </fieldset>
  );
}
