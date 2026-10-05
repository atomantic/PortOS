import CastAndSetsCheckin from '../CastAndSetsCheckin.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';

/**
 * Cast & Sets: the check-in the autopilot stops at before planning — approve,
 * regenerate with notes, resume or skip — and the sheets it saved.
 */
export default function CastSetsStage({ board }) {
  const { project, locked, castSets, kickoff } = board;
  return (
    <div className="min-w-0 space-y-3">
      {project.castAndSets ? (
        <CastAndSetsCheckin
          project={project}
          busy={locked || castSets.busy || kickoff.running}
          onOpenSheet={board.openArtifact}
          onApprove={board.approveCastAndSets}
          onRegenerate={() => castSets.regenerate()}
          onEditDirection={castSets.editDirection}
          onResume={() => castSets.resume()}
          onRebuild={() => castSets.start()}
          onSkip={board.skipCastAndSets}
        />
      ) : (
        <p className="rounded-lg border border-port-border bg-port-card p-3 text-sm text-port-text-muted">
          The autopilot builds the cast and sets — and stops for your check-in — before it plans the shots.
          Run it from the header or the Produce tab; a hands-on project can skip this stage.
        </p>
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
