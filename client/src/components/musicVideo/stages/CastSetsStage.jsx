import CastAndSetsCheckin from '../CastAndSetsCheckin.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import StageSection from '../StageSection.jsx';
import CreativeSetupPanel from '../CreativeSetupPanel.jsx';
import LookReferencesPanel from '../LookReferencesPanel.jsx';
import VisualSpecPanel from '../VisualSpecPanel.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import { formatCount } from '../../../utils/formatters.js';

const directionSummary = (project) => {
  const refs = (project.visualSpec?.references || []).length + (project.styleReferences || []).length;
  const characterStyle = project.concept?.characterStyleId
    ? (project.concept.characterStyle?.split(':')[0] || project.concept.characterStyleId) : '';
  return [
    characterStyle ? `Character style: ${characterStyle}` : 'No character style',
    project.concept?.prompt?.trim() ? 'Concept written' : 'No concept yet',
    project.concept?.style?.trim() ? 'Style set' : 'No style yet',
    refs ? `${formatCount(refs)} look ${refs === 1 ? 'reference' : 'references'}` : 'No look references',
  ].join(' · ');
};

/** Concept, style, universe and look references: what the cast and sets are built from. */
function CreativeDirection({ board }) {
  const { project, locked, conceptDraft, styleDraft } = board;
  return (
    <>
      <CreativeSetupPanel
        key={`creative-${project.id}`}
        project={project}
        onPendingChange={board.setCreativeSetupPending}
        onSave={board.saveCreativeSetup}
      />
      <LookReferencesPanel key={`look-${project.id}`} project={project}
        onSave={board.saveStyleReferences} onSaveSpec={board.saveVisualSpec} onAddReference={board.onAddReference}
        onPendingChange={board.setStyleReferencesPending} />
      <fieldset disabled={locked} className="min-w-0 space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="mv-concept" className="mb-1 block text-xs text-port-text-muted">Concept</label>
            <AutoSizeTextarea
              id="mv-concept"
              value={conceptDraft.value}
              rows={2}
              maxLength={8000}
              onChange={conceptDraft.onChange}
              onBlur={conceptDraft.onBlur}
              placeholder="What the video is about: story, theme or thread for the plan to build on."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="mv-style" className="mb-1 block text-xs text-port-text-muted">Visual style</label>
            <AutoSizeTextarea
              id="mv-style"
              value={styleDraft.value}
              rows={2}
              maxLength={2000}
              onChange={styleDraft.onChange}
              onBlur={styleDraft.onBlur}
              placeholder="Art style, palette and mood, added to every frame and shot prompt."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <VisualSpecPanel key={project.id} project={project} onSave={board.saveVisualSpec} />
      </fieldset>
    </>
  );
}

/**
 * Look: the creative direction the cast and sets are built from, the check-in
 * the autopilot stops at before planning (approve, regenerate with notes,
 * resume or skip), and the sheets it saved. The art-direction approval closes
 * the step at the bottom of the page.
 */
export default function CastSetsStage({ board }) {
  const { project, locked, castSets, kickoff } = board;
  return (
    <div className="min-w-0 space-y-3">
      <StageSection id="mv-setup-direction" title="Creative direction" summary={directionSummary(project)}
        defaultOpen={!project.concept?.prompt?.trim() && !project.castAndSets}>
        <CreativeDirection board={board} />
      </StageSection>
      {project.castAndSets ? (
        <CastAndSetsCheckin
          project={project}
          stale={board.productionReadiness?.castAndSets?.stale || null}
          busy={locked || castSets.busy || kickoff.running}
          onOpenSheet={board.openArtifact}
          onApprove={board.approveCastAndSets}
          onRegenerate={() => castSets.regenerate()}
          onEditDirection={castSets.editDirection}
          onResume={() => castSets.resume()}
          onRebuild={() => castSets.start()}
          onReconfirm={() => castSets.reconfirm()}
          onRevert={board.onRevertApproval ? (field) => board.onRevertApproval('castAndSets', field) : undefined}
          onSkip={board.skipCastAndSets}
        />
      ) : (
        <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-3">
          <p className="text-sm text-port-text-muted">Build the cast and sets from your direction, or skip and add your own sheets.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => castSets.start()} disabled={locked || castSets.busy || kickoff.running || !project.audioAnalysis}
              title={project.audioAnalysis ? undefined : 'Analyze the track first'}
              className="min-h-10 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              Build cast &amp; sets
            </button>
            <button type="button" onClick={() => castSets.skip()} disabled={locked || castSets.busy || kickoff.running}
              className="min-h-10 rounded-lg border border-port-border px-3 py-2 text-sm text-port-text-muted hover:text-white disabled:opacity-50">
              Skip
            </button>
          </div>
        </div>
      )}
      <DevArtifactsPanel
        project={project}
        busy={board.devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
        onUseAsGuide={board.useAsGuide}
        guideId={project.productionReview?.draft?.guideArtifactId || null}
        title="Cast & Sets sheets and visual guides"
        emptyText="The check-in sheet appears here once the cast and sets are built — or import your own guide"
      />
    </div>
  );
}
