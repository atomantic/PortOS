import useCatalogCastSetsCheckin from '../../../hooks/useCatalogCastSetsCheckin.js';
import CastAndSetsReferenceProgress from '../CastAndSetsReferenceProgress.jsx';
import CastAndSetsCheckin from '../CastAndSetsCheckin.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import StageSection from '../StageSection.jsx';
import LookReferencesPanel from '../LookReferencesPanel.jsx';
import CatalogLookReferences from '../CatalogLookReferences.jsx';
import VisualSpecPanel from '../VisualSpecPanel.jsx';
import CameoRosterPanel from '../CameoRosterPanel.jsx';
import { formatCount } from '../../../utils/formatters.js';
import useMusicVideoCastingChanges from '../../../hooks/useMusicVideoCastingChanges.js';
import { CAST_CHECKIN_ANCHOR, LOOK_GUIDES_ANCHOR } from '../../../lib/musicVideoStages.js';

// Below the sticky project header when a checklist row scrolls here.
const ANCHOR_STYLE = { scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' };

export const directionSummary = (project) => {
  const specRefs = (project.visualSpec?.references || []).length;
  const styleImages = (project.styleReferences || []).length;
  const characterStyle = project.concept?.characterStyleId
    ? (project.concept.characterStyle?.split(':')[0] || project.concept.characterStyleId) : '';
  // A character style is an optional preset; without one, the cast's own lead is the character.
  const lead = (project.concept?.subjects || []).find((s) => s.role === 'protagonist')?.name;
  return [
    characterStyle ? `Character style: ${characterStyle}` : lead ? `Original character: ${lead}` : null,
    project.concept?.prompt?.trim() ? 'Concept written' : 'No concept yet',
    // "Visual", so an empty frame style never reads as a missing song style.
    project.concept?.style?.trim() ? 'Visual style set' : 'No visual style yet',
    ...(project.concept?.songStyle?.trim() ? ['Song style set'] : []),
    // References and uploaded style images are counted apart: they are two lists in the panel.
    ...(specRefs ? [`${formatCount(specRefs)} ${specRefs === 1 ? 'reference' : 'references'}`] : []),
    ...(styleImages ? [`${formatCount(styleImages)} style ${styleImages === 1 ? 'image' : 'images'}`] : []),
    ...(specRefs || styleImages ? [] : ['No look references']),
  ].filter(Boolean).join(' · ');
};

/**
 * Look: the creative direction the cast and sets are built from, the check-in
 * the autopilot stops at before planning (approve, regenerate with notes,
 * resume or skip), and the sheets it saved. The art-direction approval closes
 * the step at the bottom of the page.
 */
export default function CastSetsStage({ board }) {
  const { project, locked, castSets, kickoff } = board;
  const catalogMode = project.castAndSets?.source === 'catalog';
  const catalog = useCatalogCastSetsCheckin(project, board.applyCatalogCheckin);
  const catalogBusy = locked || castSets.busy || kickoff.running;
  const canApproveCatalog = !!catalog.checkin && !catalog.checkin.problems.length && !catalog.checkin.approved;

  const { changes: castingChanges, loadError: castingChangesError, retry: retryCastingChanges } = useMusicVideoCastingChanges(project);
  return (
    <div className="min-w-0 space-y-3">
      <p id="mv-setup-direction" className="px-1 text-xs text-port-text-muted" style={ANCHOR_STYLE}>
        Concept, song style and cast are on the{' '}
        <button type="button" onClick={() => board.goToStage('story', 'mv-story-direction')} className="min-h-[44px] text-port-accent hover:underline sm:min-h-0">Story step</button>.
      </p>
      <CatalogLookReferences key={`catalog-${project.id}`} project={project} onSaveSpec={board.saveVisualSpec} onLinked={board.applyCastLinks}
        checkin={catalog.checkin} catalogOnly={catalogMode} disabled={catalogBusy}>
        {catalogMode ? <div id={CAST_CHECKIN_ANCHOR} style={ANCHOR_STYLE} className="space-y-2" aria-label="Catalog Cast & Sets check-in">
          <p className="text-sm font-medium">Cast &amp; Sets check-in · {catalog.checkin?.approved ? 'Approved' : 'Review catalog links'}</p>
          {catalog.error ? <p role="alert" className="text-xs text-port-error">{catalog.error} <button type="button" className="min-h-11 rounded border border-port-border px-2" onClick={catalog.retry}>Retry catalog check-in</button></p>
            : !catalog.checkin ? <p className="text-xs">Loading current catalog check-in…</p> : null}
          {catalog.checkin?.problems.length > 0 && <ul className="list-disc pl-5 text-xs text-port-warning">{catalog.checkin.problems.map((problem, index) => <li key={`${problem.subjectId}:${problem.code}:${index}`}>{problem.message}</li>)}</ul>}
          <button type="button" className="min-h-11 rounded border border-port-border px-3 text-sm disabled:opacity-50" disabled={catalogBusy || !canApproveCatalog}
            onClick={() => (project.castAndSets.status === 'approved' ? castSets.reconfirm : board.approveCastAndSets)(catalog.checkin.basis)}>Approve catalog Cast &amp; Sets</button>
        </div> : castSets.linkCatalog && <div className="space-y-1">
          <p className="text-xs text-port-text-muted">Switch this check-in to catalog links only. Existing generated sheets and shot references stay in history.</p>
          <button type="button" disabled={catalogBusy} className="min-h-11 rounded border border-port-border px-3 text-sm disabled:opacity-50" onClick={castSets.linkCatalog}>Use catalog-only check-in</button>
        </div>}
      </CatalogLookReferences>
      <StageSection title="Mood board & other asset links" summary={directionSummary(project)}>
        <LookReferencesPanel key={`look-${project.id}`} project={project}
          onSave={board.saveStyleReferences} onSaveSpec={board.saveVisualSpec} onAddReference={board.onAddReference}
          onReferenceLabels={board.applyReferenceLabels} onPendingChange={board.setStyleReferencesPending} />
        <fieldset disabled={locked} className="min-w-0"><VisualSpecPanel key={project.id} project={project} onSave={board.saveVisualSpec} /></fieldset>
      </StageSection>
      <CameoRosterPanel project={project} onApply={board.applyCameos} disabled={locked} />
      {catalogMode ? (project.castAndSets.plan && <StageSection title="Previous generated sheet · history" summary="Saved outputs and submitted inputs; not current Cast & Sets">
        <CastAndSetsReferenceProgress stage={project.castAndSets} onOpenPreview={board.openPreview} />
      </StageSection>) : project.castAndSets ? (
        <CastAndSetsCheckin
          id={CAST_CHECKIN_ANCHOR}
          project={project}
          stale={board.productionReadiness?.castAndSets?.stale || null}
          storyStale={board.productionReadiness?.castAndSets?.storyStale || null}
          castingChanges={castingChanges}
          castingChangesError={castingChangesError}
          onRetryCastingChanges={retryCastingChanges}
          busy={locked || castSets.busy || kickoff.running}
          onOpenSheet={board.openArtifact}
          onOpenPreview={board.openPreview}
          onApprove={board.approveCastAndSets}
          onAcknowledgeImage={castSets.acknowledgeImage}
          onReinspectImages={castSets.reinspectImages}
          onRegenerate={() => castSets.regenerate()}
          onRegenerateImages={castSets.regenerateImages}
          onEditDirection={castSets.editDirection}
          onUseImage={castSets.useImage}
          onEditImage={castSets.editImage}
          onAcceptImageEdit={castSets.acceptImageEdit}
          onDiscardImageEdit={castSets.discardImageEdit}
          onRefresh={castSets.refresh}
          onApplyFeedback={castSets.applyFeedback}
          onRenderFeedback={castSets.renderFeedback}
          onRefreshFeedbackRenderer={castSets.refreshFeedbackRenderer}
          onRemoveFeedback={castSets.removeFeedback}
          onRemoveImageFeedback={castSets.removeImageFeedback}
          onRegenerateWithNotes={castSets.regenerate}
          onResume={() => castSets.resume()}
          onRebuild={() => castSets.start()}
          onReconfirm={() => castSets.reconfirm()}
          onRevert={board.onRevertApproval ? (field) => board.onRevertApproval('castAndSets', field) : undefined}
          onSkip={board.skipCastAndSets}
          onDiscard={castSets.discard}
          onRebuildFromStory={() => castSets.rebuildFromStory(project.castAndSets.status)}
        />
      ) : (
        // Build lives on the step's checklist (and the header); this keeps only the way out.
        <p id={CAST_CHECKIN_ANCHOR} tabIndex={-1} style={ANCHOR_STYLE} className="px-1 text-xs text-port-text-muted">
          Using your own sheets instead?{' '}
          <button type="button" onClick={() => castSets.skip()} disabled={locked || castSets.busy || kickoff.running}
            className="min-h-[44px] text-port-accent hover:underline disabled:opacity-50 sm:min-h-0">
            Skip cast &amp; sets
          </button>
        </p>
      )}
      <DevArtifactsPanel
        id={LOOK_GUIDES_ANCHOR}
        project={project}
        busy={board.devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
        onUseAsGuide={board.useAsGuide}
        guideId={project.productionReview?.draft?.guideArtifactId || null}
        title={catalogMode ? "Visual guides & sheet history" : "Cast & Sets sheets and visual guides"}
        emptyText={catalogMode ? "Optional visual guides are separate from the catalog Cast & Sets check-in." : "The check-in sheet appears here once the cast and sets are built — or import your own guide"}
      />
    </div>
  );
}
