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
        <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-3">
          <p className="text-sm text-port-text-muted">
            The cast and sets are built — and stop for your check-in — before the shots are planned.
            Build them now, or skip this stage and work from the sheets you add yourself.
          </p>
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
