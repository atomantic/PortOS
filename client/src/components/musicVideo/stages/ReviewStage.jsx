import SharingCopyPanel from '../SharingCopyPanel.jsx';
import DependencyImpactPanel from '../DependencyImpactPanel.jsx';
import RenderStatusPanel, { RenderFailure } from '../RenderStatusPanel.jsx';
import ExcerptPanel from '../ExcerptPanel.jsx';
import StageSection from '../StageSection.jsx';
import { isFinalRenderStale } from '../../../lib/musicVideoStages.js';
import { RenderFinalButton } from '../ProjectActionGroups.jsx';
import ReviewDraftPanel from '../ReviewDraftPanel.jsx';
import { latestMusicVideoReviewDraft } from '../../../../../server/lib/musicVideoReviewDraft.js';

/**
 * Final render: the full render and its player first, then draft excerpts with
 * review notes, section revision and auto-review (they act on the excerpt
 * window, so they live beside it), then dependency repair. Development files,
 * the external handoff and the making-of export are in Project settings › Files.
 */
export default function ReviewStage({ board }) {
  const {
    project, locked, renderJob, renderBound, finalVideo, excerpts, revisions, autoReview, sceneMedia,
  } = board;
  const hasDraft = !!latestMusicVideoReviewDraft(project);
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      {!project.renderHistoryId && <ReviewDraftPanel project={project} onOpen={board.openArtifact} draftState={board.reviewDraftState} />}
      <RenderFailure project={project} renderJob={renderJob} />
      <section id="mv-final-video" aria-label="Final render" className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-card p-3">
        <div className="flex justify-end">
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
      </section>

      <StageSection title="Drafts and revisions" summary="Render any range to check it, add notes, revise sections" defaultOpen={!hasDraft || excerpts.rendering}>
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

      <StageSection title="Dependency changes and repair"><DependencyImpactPanel project={project} busy={revisions.busy} onRepair={revisions.repair} /></StageSection>
    </fieldset>
  );
}
