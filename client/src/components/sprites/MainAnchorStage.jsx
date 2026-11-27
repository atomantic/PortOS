import { Lock, Sparkles, RefreshCw, GitFork, Unlock } from 'lucide-react';
import { CorrectionNoteToggle, MAIN_CORRECTION_KEY } from './CorrectionNote.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { CandidateTile, SpriteImg, StageHeading } from './ReferenceStagePrimitives';

export default function MainAnchorStage({
  recordId,
  manifest,
  mainLocked,
  turnaroundLocked,
  mainUnlockConfirming,
  setMainUnlockConfirming,
  mainUnlocking,
  unlockMain,
  anchorSeededPhrase,
  setForkOpen,
  modePicker,
  mode,
  pendingJobs,
  generate,
  mainCandidates,
  corrections,
  onCorrectionChange,
  locking,
  clipRisks,
  lock,
}) {
  return (
    <section
      aria-labelledby="sprite-main-reference-heading"
      className="min-w-0 space-y-4 rounded-xl border border-port-border bg-port-bg/50 p-3 sm:p-4"
    >
      <StageHeading
        id="sprite-main-reference-heading"
        number="2"
        title="Main reference"
        status={mainLocked ? 'Locked walk-south identity' : turnaroundLocked ? 'Ready to derive from the front view' : 'Waiting for the turnaround sheet'}
        statusTone={mainLocked ? 'text-port-success' : turnaroundLocked ? 'text-port-accent' : 'text-gray-500'}
      />

      {mainLocked ? (
        <div className="grid items-start gap-3 @3xl:grid-cols-[minmax(12rem,18rem)_1fr] @5xl:grid-cols-1">
          <SpriteImg
            recordId={recordId}
            path={manifest.mainReference.path}
            className="w-full aspect-square rounded-lg border border-port-border bg-port-bg object-contain"
          />
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-xs text-port-success">
              <Lock className="h-3.5 w-3.5" /> Frozen · turnaround-derived
            </p>
            <p className="text-[11px] leading-relaxed text-gray-500">
              This front-facing reference seeds thumbnails and the walk-south identity. Reopen it to derive a better front view from this turnaround, or reopen the turnaround to rebuild the full reference chain.
            </p>
            {turnaroundLocked && (mainUnlockConfirming ? (
              <div className="rounded border border-port-warning/40 bg-port-warning/10 p-2 text-[11px]">
                <p className="text-port-warning">
                  Reopen the main reference and its south {anchorSeededPhrase}? The turnaround and other directions stay locked; existing files remain in history.
                </p>
                <ConfirmButtonPair
                  className="mt-2 flex-wrap"
                  confirmText="Unlock for regeneration"
                  confirmIcon={Unlock}
                  tone="warning"
                  busy={mainUnlocking}
                  busyText="Unlocking…"
                  ariaLabel="Confirm unlock main reference"
                  onConfirm={unlockMain}
                  onCancel={() => setMainUnlockConfirming(false)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setMainUnlockConfirming(true)}
                disabled={mainUnlocking}
                className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1.5 text-xs text-gray-300 hover:border-port-warning hover:text-port-warning disabled:opacity-50"
              >
                <Unlock className="h-3.5 w-3.5" /> Unlock main reference
              </button>
            ))}
            <button
              type="button"
              onClick={() => setForkOpen(true)}
              className="flex min-h-9 w-full items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1.5 text-xs text-gray-300 hover:border-port-accent"
            >
              <GitFork className="h-3.5 w-3.5" /> Fork from this reference
            </button>
          </div>
        </div>
      ) : turnaroundLocked ? (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-gray-500">
            Redrawn from the sheet&rsquo;s front panel — no separate design input.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end @5xl:flex-col @5xl:items-stretch">
            {modePicker}
            <button
              type="button"
              onClick={() => generate('main')}
              disabled={!mode || !!pendingJobs.main}
              className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {pendingJobs.main ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {pendingJobs.main ? 'Rendering…' : mainCandidates.length ? 'Regenerate' : 'Generate candidate'}
            </button>
          </div>
          {/* The main has no design input of its own (it derives from the
              sheet), but it CAN take a correction (#3134) — otherwise a bad
              front view could only be re-rolled blind. */}
          <CorrectionNoteToggle
            noteKey={MAIN_CORRECTION_KEY}
            label="main reference"
            corrections={corrections}
            onChange={onCorrectionChange}
            placeholder="Correction (optional), e.g. the cloak hem is cut off"
          />
          {mainCandidates.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3">
              {mainCandidates.map((candidate) => (
                <CandidateTile
                  key={candidate.path}
                  recordId={recordId}
                  candidate={candidate}
                  locking={locking}
                  clipRisk={clipRisks[candidate.path]}
                  onLock={(picked, accept) => lock('main', picked, accept)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-port-border bg-port-bg px-4 text-center">
          <p className="max-w-xs text-[11px] text-gray-600">Lock the turnaround sheet to unlock this stage.</p>
        </div>
      )}
    </section>
  );
}
