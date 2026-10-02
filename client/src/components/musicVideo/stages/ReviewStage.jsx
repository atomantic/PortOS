import DependencyImpactPanel from '../DependencyImpactPanel.jsx';
import RenderStatusPanel from '../RenderStatusPanel.jsx';
import ExcerptPanel from '../ExcerptPanel.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import HandoffControls from '../HandoffControls.jsx';
import StageSection from '../StageSection.jsx';
import { RenderFinalButton } from '../ProjectActionGroups.jsx';

/**
 * Review & Export: the final render and its player, draft excerpts with review
 * notes, section revision and auto-review (they act on the excerpt window, so
 * they live beside it), every development file, and the external-tool handoff.
 */
export default function ReviewStage({ board }) {
  const {
    project, locked, renderJob, renderBound, finalVideo, excerpts, revisions, autoReview, sceneMedia, devArtifacts, takes,
  } = board;
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3">
      <DependencyImpactPanel project={project} busy={revisions.busy} onRepair={revisions.repair} />
      <section id="mv-final-video" aria-label="Final render" className="rounded-lg border border-port-border bg-port-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Final render</h3>
          <RenderFinalButton project={project} renderJob={renderJob} readiness={board.productionReadiness} />
        </div>
        <RenderStatusPanel
          rendering={renderBound}
          progress={renderJob.progress}
          renderHistoryId={project.renderHistoryId}
          finalVideo={finalVideo}
          onOpenPreview={board.openPreview}
        />
      </section>

      <div className="rounded-lg border border-port-border bg-port-card p-3">
        <ExcerptPanel
          project={project}
          rendering={excerpts.rendering}
          progress={excerpts.progress}
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

      <DevArtifactsPanel
        project={project}
        busy={devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
      />

      <StageSection title="External handoff" summary="Export prompts, import files made in other tools">
        <HandoffControls
          projectId={project.id}
          busy={takes.busy}
          onExport={takes.exportHandoff}
          onExportBundle={takes.exportHandoffBundle}
          onImport={takes.importHandoffFiles}
          onOpenContactSheet={board.openContactSheet}
        />
      </StageSection>
    </fieldset>
  );
}
