import DependencyImpactPanel from '../DependencyImpactPanel.jsx';
import RenderStatusPanel, { RenderFailure } from '../RenderStatusPanel.jsx';
import ExcerptPanel from '../ExcerptPanel.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import StageSection from '../StageSection.jsx';
import { isFinalRenderStale } from '../../../lib/musicVideoStages.js';
import { RenderFinalButton } from '../ProjectActionGroups.jsx';

/**
 * Review & Export: the final render and its player, draft excerpts with review
 * notes, section revision and auto-review (they act on the excerpt window, so
 * they live beside it), and every development file. The external-tool handoff lives on Produce.
 */
export default function ReviewStage({ board }) {
  const {
    project, locked, renderJob, renderBound, finalVideo, excerpts, revisions, autoReview, sceneMedia, devArtifacts,
  } = board;
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <RenderFailure project={project} renderJob={renderJob} />
      <StageSection title="Dependency changes and repair"><DependencyImpactPanel project={project} busy={revisions.busy} onRepair={revisions.repair} /></StageSection>
      <section id="mv-final-video" aria-label="Final render" className="rounded-lg border border-port-border bg-port-card p-3">
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
      </section>

      <div className="rounded-lg border border-port-border bg-port-card p-3">
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
      </div>

      <StageSection title="Development files" summary="Guides, storyboards and contact sheets">
      <DevArtifactsPanel
        project={project}
        busy={devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
      />
      </StageSection>

    </fieldset>
  );
}
