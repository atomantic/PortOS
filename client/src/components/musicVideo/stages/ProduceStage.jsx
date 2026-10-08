import ContactSheetButton from '../ContactSheetButton.jsx';
import StageSection from '../StageSection.jsx';
import { GenerationActions } from '../ProjectActionGroups.jsx';
import ShotStatusStrip from '../ShotStatusStrip.jsx';
import CompositionPanel from '../CompositionPanel.jsx';
import { isLayeredComposition } from '../../../lib/musicVideoLayers.js';
import { FOOTAGE_OPTIONAL_MODES } from '../../../lib/musicVideoStages.js';

/**
 * Make: the picture for every shot, then the composition over it. A render
 * style that draws its own picture (code, document, Eidoverse) keeps the
 * footage tools folded, since footage is optional there. The optional animated proof sits at the bottom of
 * the page with the other approvals; the autopilot and production runs live in
 * Project settings › Autopilot.
 */
export default function ProduceStage({ board }) {
  const { project, locked, videoSettings, sceneMedia } = board;
  const footageOptional = FOOTAGE_OPTIONAL_MODES.has(project.composition?.mode || 'concat');
  const hasScenes = (project.scenes || []).length > 0;
  return (
    <div className="min-w-0 space-y-3">
      <fieldset disabled={locked} className="min-w-0 space-y-3">
          <StageSection id="mv-generation" title="Footage" defaultOpen={!footageOptional}
            summary={footageOptional ? 'Optional for this render style: frames and clips the composition can use' : 'Make the frames and clips each shot still needs'}>
            {hasScenes && (
              <ShotStatusStrip projectId={project.id} scenes={project.scenes} ctx={{
                layered: isLayeredComposition(project),
                footageOptional,
                lipSyncBackend: videoSettings.audioReactiveSelected ? 'local' : videoSettings.settings.backend,
                songDurationSec: project.audioAnalysis?.durationSec ?? null,
                failed: sceneMedia.failedScenes,
                songReview: project.songRevision?.sceneReview || null,
              }} />
            )}
            <div className="flex justify-end"><ContactSheetButton onOpen={board.openContactSheet} /></div>
            <GenerationActions project={project} videoSettings={videoSettings} sceneMedia={sceneMedia} onEditServices={() => board.openSettings('project')} />
          </StageSection>
      </fieldset>
      <section id="mv-composition" aria-label="Composition" className="min-w-0 space-y-2">
        <h4 className="text-sm font-medium">Composition</h4>
        <CompositionPanel board={board} />
      </section>
    </div>
  );
}
