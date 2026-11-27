import { Scissors } from 'lucide-react';
import WalkCandidateActions from './WalkCandidateActions.jsx';
import WalkErrorRecovery from './WalkErrorRecovery.jsx';
import WalkReopenControls from './WalkReopenControls.jsx';
import WalkStatusPreview from './WalkStatusPreview.jsx';

export default function WalkDirectionCard({
  recordId, direction, anchorLocked, anchorPath, run, approved, finalized, pending,
  onOpenTrimmer, onGenerate, onApprove, onRetry, onReprocess, onReopen,
  reprocessing, retrying, cycleLabel, drift, targetSaving, imported,
  corrections, onCorrectionChange, provider, conditioning, onConditioningChange, conditioningSupported,
}) {
  const candidate = run?.status === 'candidate' ? run : null;
  const rendering = run?.status === 'rendering';
  const supersededAnchor = run?.status === 'superseded-anchor';
  // Any run that carries a packed strip preview is trimmable — the trim service
  // resolves geometry from the run's own manifest/stripPreview regardless of
  // on-disk layout (native `runs/`, legacy `grok/`, imported `runs/`, or an
  // imagegen redraw), so there's no vendor-directory coupling here anymore. The
  // link stands for approved and finalized runs too, since a trim is a
  // non-destructive derived artifact under `walk/trims/`.
  const trimmable = Boolean(run?.stripPreview?.stripPath) && !supersededAnchor;
  const hasSourceClip = Boolean(run?.sourceVideoPath) && !run?.sourceClipMissing;

  return (
    <div className="bg-port-bg border border-port-border rounded p-2 space-y-1.5">
      <WalkStatusPreview
        recordId={recordId}
        direction={direction}
        anchorLocked={anchorLocked}
        anchorPath={anchorPath}
        run={run}
        approved={approved}
        finalized={finalized}
        pending={pending}
        candidate={candidate}
        rendering={rendering}
        supersededAnchor={supersededAnchor}
        hasSourceClip={hasSourceClip}
        drift={drift}
        cycleLabel={cycleLabel}
        imported={imported}
      />
      <WalkErrorRecovery
        recordId={recordId}
        direction={direction}
        run={run}
        hasSourceClip={hasSourceClip}
        pending={pending}
        targetSaving={targetSaving}
        retrying={retrying}
        onRetry={onRetry}
      />
      <WalkCandidateActions
        recordId={recordId}
        direction={direction}
        anchorLocked={anchorLocked}
        anchorPath={anchorPath}
        run={run}
        candidate={candidate}
        approved={approved}
        finalized={finalized}
        pending={pending}
        rendering={rendering}
        targetSaving={targetSaving}
        provider={provider}
        conditioning={conditioning}
        onConditioningChange={onConditioningChange}
        conditioningSupported={conditioningSupported}
        corrections={corrections}
        onCorrectionChange={onCorrectionChange}
        onGenerate={onGenerate}
        onReprocess={onReprocess}
        reprocessing={reprocessing}
        cycleLabel={cycleLabel}
        drift={drift}
        onApprove={onApprove}
      />
      <WalkReopenControls
        direction={direction}
        run={run}
        approved={approved}
        finalized={finalized}
        onReopen={onReopen}
      />

      {/* The single trim UI now lives in the Loop Trimmer workspace (#2933);
          each card just links into it, deep-linked to this run. Shown for
          approved and finalized directions too — the trim is a non-destructive
          derived artifact, so trimming an approved loop is always allowed. */}
      {trimmable && (
        <button
          type="button"
          onClick={() => onOpenTrimmer(run.id)}
          title="Open this run in the Loop Trimmer"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
        >
          <Scissors className="w-3 h-3" /> Edit in Loop Trimmer
        </button>
      )}
    </div>
  );
}
