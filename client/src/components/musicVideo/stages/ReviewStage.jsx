import SharingCopyPanel from '../SharingCopyPanel.jsx';
import DependencyImpactPanel from '../DependencyImpactPanel.jsx';
import RenderStatusPanel, { RenderFailure } from '../RenderStatusPanel.jsx';
import ExcerptPanel from '../ExcerptPanel.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import MakingOfExportPanel from '../MakingOfExportPanel.jsx';
import StageSection from '../StageSection.jsx';
import { isFinalRenderStale } from '../../../lib/musicVideoStages.js';
import { RenderFinalButton } from '../ProjectActionGroups.jsx';
import ReviewDraftPanel from '../ReviewDraftPanel.jsx';
import { latestMusicVideoReviewDraft } from '../../../../../server/lib/musicVideoReviewDraft.js';

/**
 * Review & Export: the final render and its player, draft excerpts with review
 * notes, section revision and auto-review (they act on the excerpt window, so
 * they live beside it), and every development file. The external-tool handoff lives on Produce.
 */
export default function ReviewStage({ board }) {
  const {
    project, locked, renderJob, renderBound, finalVideo, excerpts, revisions, autoReview, sceneMedia, devArtifacts,
  } = board;
  const hasDraft = !!latestMusicVideoReviewDraft(project);
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      {!project.renderHistoryId && <ReviewDraftPanel project={project} onOpen={board.openArtifact} draftState={board.reviewDraftState} />}
      <RenderFailure project={project} renderJob={renderJob} />
      <StageSection title="Dependency changes and repair"><DependencyImpactPanel project={project} busy={revisions.busy} onRepair={revisions.repair} /></StageSection>
      <StageSection id="mv-final-video" title="Native final render" defaultOpen={!hasDraft || !!project.renderHistoryId || renderBound}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Final render</h3>
          <RenderFinalButton project={project} renderJob={renderJob} readiness={board.productionReadiness} />
        </div>
        <RenderStatusPanel
          rendering={renderBound}
          progress={renderJob.progress}
          renderHistoryId={project.renderHistoryId}
          stale={isFinalRenderStale(project)}
          finalVideo={finalVideo}
          onOpenPreview={board.openPreview}
        />
        {project.renderHistoryId && <SharingCopyPanel key={`${project.id}:${project.renderHistoryId}`} projectId={project.id} />}
      </StageSection>

      <StageSection title="Excerpt and revision tools" defaultOpen={!hasDraft || excerpts.rendering}>
        <ExcerptPanel
          project={project}
          rendering={excerpts.rendering}
          occupied={excerpts.occupied}
          progress={excerpts.progress}
          activeRenderId={excerpts.activeRenderId}
          connected={excerpts.connected}
          excerpts={project.excerpts || []}
          deletingId={excerpts.deletingId}
          noteBusyId={excerpts.noteBusyId}
          startExcerpt={excerpts.startExcerpt}
          cancelExcerpt={excerpts.cancelExcerpt}
          deleteExcerpt={excerpts.deleteExcerpt}
          addNote={excerpts.addNote}
          editNote={excerpts.editNote}
          deleteNote={excerpts.deleteNote}
          revision={{ ...revisions, genScenes: sceneMedia.genScenes, genVideoScenes: sceneMedia.genVideoScenes }}
          autoReview={autoReview}
        />
      </StageSection>

      <div id="mv-review-development"><DevArtifactsPanel
        project={project}
        busy={devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
      /></div>

      <StageSection title="Making-of export">
      <MakingOfExportPanel project={project} />
      </StageSection>

    </fieldset>
  );
}
