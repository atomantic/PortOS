import { Lock, Sparkles, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import CorrectionNote from './CorrectionNote.jsx';
import { CandidateTile, LockedAnchor, StageHeading } from './ReferenceStagePrimitives';

export default function DirectionalAnchorsStage({
  manifest,
  recordId,
  allAnchorsLocked,
  anchorProgress,
  turnaroundLocked,
  anchorsOpen,
  setAnchorsOpen,
  modePicker,
  candidatesByTarget,
  anchorUnlocking,
  unlockAnchor,
  corrections,
  onCorrectionChange,
  generate,
  mode,
  pendingJobs,
  locking,
  clipRisks,
  lock,
}) {
  return (
    <section
      aria-labelledby="sprite-directional-anchors-heading"
      className="space-y-3 rounded-xl border border-port-border bg-port-bg/50 p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageHeading
          id="sprite-directional-anchors-heading"
          number="3"
          title="Directional anchors"
          status={allAnchorsLocked ? `${anchorProgress} · complete` : anchorProgress}
          statusTone={allAnchorsLocked ? 'text-port-success' : turnaroundLocked ? 'text-port-accent' : 'text-gray-500'}
        />
        <div className="flex flex-wrap items-center gap-2">
          {anchorsOpen && !allAnchorsLocked && modePicker}
          <button
            type="button"
            onClick={() => setAnchorsOpen((open) => !open)}
            aria-expanded={anchorsOpen}
            className="flex min-h-8 items-center gap-1 rounded border border-port-border bg-port-card px-2.5 py-1 text-xs text-gray-300 hover:border-port-accent"
          >
            {anchorsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {anchorsOpen ? 'Hide anchors' : 'Show anchors'}
          </button>
        </div>
      </div>

      {!anchorsOpen && (
        <p className="text-[10px] text-gray-600">
          {allAnchorsLocked
            ? 'The frozen files remain available in the Reference set asset collection below.'
            : 'Expand to generate, review, and lock each directional identity.'}
        </p>
      )}
      {anchorsOpen && !allAnchorsLocked && (
        <p className="text-[10px] text-gray-600">
          {turnaroundLocked
            ? 'Each anchor is redrawn from the turnaround sheet’s matching side.'
            : 'Blocked: generate and lock the turnaround sheet above first — anchors are drawn from it.'}
        </p>
      )}
      {anchorsOpen && (
        <div className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 ${allAnchorsLocked ? '@5xl:grid-cols-8' : ''}`}>
          {manifest.anchors.map((anchor) => {
            const anchorCandidates = candidatesByTarget[anchor.direction] || [];
            return (
              <div key={anchor.id} className="min-w-0 space-y-2 rounded-lg border border-port-border bg-port-bg p-2">
                <h5 className="flex items-center justify-between text-xs capitalize text-gray-400">
                  {anchor.direction}
                  {anchor.status === 'locked' && <Lock className="h-3 w-3 text-port-success" />}
                </h5>
                {anchor.status === 'locked' ? (
                  <LockedAnchor
                    recordId={recordId}
                    anchor={anchor}
                    // South is the immutable main reference, not a
                    // turnaround-derived directional anchor.
                    canUnlock={turnaroundLocked && anchor.direction !== 'south'}
                    unlocking={anchorUnlocking}
                    onUnlock={unlockAnchor}
                  />
                ) : (
                  <div className="space-y-2">
                    <CorrectionNote
                      direction={anchor.direction}
                      value={corrections[anchor.direction]}
                      onChange={onCorrectionChange}
                      className="text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => generate(anchor.direction)}
                      disabled={!mode || !turnaroundLocked || !!pendingJobs[anchor.direction]}
                      className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-port-border bg-port-card px-2 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50"
                    >
                      {pendingJobs[anchor.direction]
                        ? <><RefreshCw className="h-3 w-3 animate-spin" /> Rendering…</>
                        : anchorCandidates.length
                          ? <><RefreshCw className="h-3 w-3" /> Regenerate</>
                          : <><Sparkles className="h-3 w-3" /> Generate</>}
                    </button>
                    {anchorCandidates.map((candidate) => (
                      <CandidateTile
                        key={candidate.path}
                        recordId={recordId}
                        candidate={candidate}
                        locking={locking}
                        clipRisk={clipRisks[candidate.path]}
                        onLock={(picked, accept) => lock(anchor.direction, picked, accept)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
