import { useState } from 'react';
import { Check, Film, Gauge, RefreshCw } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import LocalLoopConditioning from './LocalLoopConditioning.jsx';
import { CorrectionNoteToggle, walkCorrectionKey } from './CorrectionNote.jsx';

export default function WalkCandidateActions({
  recordId, direction, anchorLocked, anchorPath, run, candidate, approved, finalized,
  pending, rendering, targetSaving, provider, conditioning, onConditioningChange,
  conditioningSupported, corrections, onCorrectionChange, onGenerate, onReprocess,
  reprocessing, cycleLabel, drift, onApprove,
}) {
  const [confirming, setConfirming] = useState(false);
  if (finalized || approved) return null;

  // The saved run keeps Generate disabled after the client's pending flag clears.
  // `targetSaving` blocks the render actions without claiming the direction is
  // rendering: the set's cycle target is mid-PATCH, so a queue now would be
  // gated against a value the server hasn't persisted yet (409 target mismatch).
  const inFlight = pending || rendering || run?.status === 'postprocessing';
  const busy = inFlight || targetSaving;

  return (
    <div className="space-y-1.5">
      {/* Correction note for the NEXT render (#3134) — the same key the
          asset-collection walk card writes, so a note typed on either
          surface is visible on both and rides whichever Generate fires.
          Hidden when this direction can't be rendered at all. */}
      {provider === 'local' && (
        <LocalLoopConditioning
          recordId={recordId}
          direction={direction}
          anchor={{ path: anchorPath }}
          enabled={conditioning}
          onChange={onConditioningChange}
          disabled={busy || !anchorLocked}
          supported={conditioningSupported}
        />
      )}
      {anchorLocked && onCorrectionChange && (
        <CorrectionNoteToggle
          noteKey={walkCorrectionKey(direction)}
          label={`${direction} walk cycle`}
          corrections={corrections}
          onChange={onCorrectionChange}
          placeholder="Correction (optional), e.g. the legs barely lift"
        />
      )}
      <button
        type="button"
        onClick={() => provider === 'local'
          ? onGenerate(direction, { returnToIdleAnchor: conditioning }) : onGenerate(direction)}
        disabled={!anchorLocked || busy || (provider === 'local' && conditioning && !conditioningSupported)}
        title={anchorLocked ? undefined : 'Lock this direction\'s reference anchor first'}
        className="flex items-center gap-1 w-full justify-center px-2 py-1 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
      >
        {inFlight
          ? <><RefreshCw className="w-3 h-3 animate-spin" /> {run?.status === 'postprocessing' ? 'Packaging…' : 'Rendering…'}</>
          : <><Film className="w-3 h-3" /> {candidate ? 'Regenerate' : 'Generate walk'}</>}
      </button>
      {/* Re-derive the loop from the clip ALREADY on disk at the current
          frame-count/speed — no grok call, no new paid render. This is the
          "make a better/slower cycle from what we have" action. */}
      {candidate && (
        <button
          type="button"
          onClick={() => onReprocess(run)}
          disabled={busy || reprocessing}
          title={`Rebuild this loop from the existing clip at ${cycleLabel} (no regeneration)`}
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
        >
          {reprocessing
            ? <><RefreshCw className="w-3 h-3 animate-spin" /> Reprocessing…</>
            : <><Gauge className="w-3 h-3" /> Reprocess · {cycleLabel}</>}
        </button>
      )}
      {candidate && (
        confirming ? (
          <ConfirmButtonPair
            className="flex-wrap"
            prompt="Approve?"
            confirmText="Approve"
            cancelText="Cancel"
            confirmIcon={Check}
            tone="success"
            ariaLabel={`Confirm approve ${direction}`}
            onConfirm={() => { setConfirming(false); onApprove(direction, candidate.id); }}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          // Approval is where a direction's geometry gets frozen into the
          // set the atlas compiles, so a drifted candidate can't be approved
          // — the server refuses it, and offering the button anyway would
          // just hand back a 409 after the click. Same for a run still
          // packaged by the source pipeline: its per-frame images were never
          // imported, so approving it 409s RUN_FRAMES_MISSING however well its
          // geometry happens to match. Reprocessing from the clip is the way
          // through, and it clears the flag.
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={Boolean(drift) || Boolean(run?.importedPackaging)}
            title={run?.importedPackaging
              ? 'This run was packaged by the source pipeline, which kept its frames — reprocess it from its clip first'
              : drift ? `Re-derive this direction to ${cycleLabel} before approving it` : undefined}
            className="min-h-[36px] w-full px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-success/20 border border-port-success rounded text-port-success disabled:opacity-50"
          >
            Approve
          </button>
        )
      )}
    </div>
  );
}
