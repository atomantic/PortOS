import { Lock, Sparkles, RefreshCw, Upload, Images, PersonStanding, Unlock, X } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import FilePickerButton from '../ui/FilePickerButton';
import { IMAGE_ACCEPT } from '../../utils/fileUpload';
import { CandidateTile, SpriteImg, StageHeading } from './ReferenceStagePrimitives';

function TurnaroundReferenceInput({
  refSource,
  pickUpload,
  strength,
  setStrength,
  clearSource,
  setGalleryOpen,
  setSpritePickerOpen,
}) {
  return (
    <>
      {refSource ? (
        <div className="flex items-center gap-3 rounded-lg border border-port-border bg-port-bg p-2">
          {refSource.type === 'sprite' ? (
            <SpriteImg recordId={refSource.id} path={refSource.path} className="h-16 w-16 shrink-0 rounded object-contain" />
          ) : (
            <img src={refSource.previewUrl} alt="reference" className="h-16 w-16 shrink-0 rounded object-contain" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-gray-300">
              {refSource.type === 'upload' ? refSource.file.name
                : refSource.type === 'gallery' ? (refSource.label || 'gallery image')
                  : refSource.name}
            </p>
            <p className="text-[10px] text-gray-500">
              {refSource.type === 'upload' ? 'uploaded image'
                : refSource.type === 'gallery' ? 'from render history'
                  : 'from reference sprite'}
            </p>
            <label className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
              Fidelity
              <input
                type="range" min="0" max="1" step="0.05" value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                className="min-w-24 flex-1 accent-port-accent"
                aria-label="Reference fidelity"
              />
              <span className="w-8 tabular-nums">{strength.toFixed(2)}</span>
            </label>
          </div>
          <button
            type="button"
            onClick={clearSource}
            aria-label="Remove reference image"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0 p-1 text-gray-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Reference image <span className="normal-case tracking-normal">(optional)</span></p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 @3xl:grid-cols-1">
            <FilePickerButton
              accept={IMAGE_ACCEPT}
              onChange={(e) => pickUpload(e.target.files?.[0] || null)}
              ariaLabel="Upload a reference image"
              className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1 text-xs text-gray-300 hover:border-port-accent"
            >
              <Upload className="h-3.5 w-3.5" /> Upload
            </FilePickerButton>
            <button
              type="button"
              onClick={() => setGalleryOpen(true)}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1 text-xs text-gray-300 hover:border-port-accent"
            >
              <Images className="h-3.5 w-3.5" /> History
            </button>
            <button
              type="button"
              onClick={() => setSpritePickerOpen(true)}
              className="flex min-h-9 items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1 text-xs text-gray-300 hover:border-port-accent"
            >
              <PersonStanding className="h-3.5 w-3.5" /> Sprite
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function TurnaroundStage({
  recordId,
  manifest,
  turnaroundLocked,
  backfilling,
  backfillOptional,
  turnaroundUnlockConfirming,
  setTurnaroundUnlockConfirming,
  turnaroundUnlocking,
  unlockTurnaround,
  anchorSeededPhrase,
  turnaroundCandidates,
  designPrompt,
  setDesignPrompt,
  referenceInput,
  modePicker,
  mode,
  pendingJobs,
  generate,
  locking,
  clipRisks,
  lock,
  turnaroundCorrections,
  setTurnaroundCorrections,
  reprocessTurnaround,
}) {
  const {
    refSource, pickUpload, strength, setStrength,
    clearSource, setGalleryOpen, setSpritePickerOpen,
  } = referenceInput;

  return (
    <section
      aria-labelledby="sprite-turnaround-heading"
      className="min-w-0 space-y-4 rounded-xl border border-port-border bg-port-bg/50 p-3 sm:p-4"
    >
      <StageHeading
        id="sprite-turnaround-heading"
        number="1"
        title="Turnaround sheet"
        status={turnaroundLocked ? 'Locked identity root' : backfillOptional ? 'Optional for future forks' : backfilling ? 'Backfill from the locked main' : 'Design the four-view identity root'}
        statusTone={turnaroundLocked ? 'text-port-success' : backfillOptional ? 'text-gray-500' : 'text-port-accent'}
      />

      {turnaroundLocked ? (
        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(16rem,1.15fr)_minmax(14rem,0.65fr)]">
          <SpriteImg
            recordId={recordId}
            path={manifest.turnaround.path}
            className="w-full aspect-square rounded-lg border border-port-border bg-port-bg object-contain"
          />
          <div className="rounded-lg border border-port-success/30 bg-port-success/10 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-port-success">
              <Lock className="h-3.5 w-3.5" /> Frozen identity root
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
              The front, right, back, and left views are fixed while this version is active. The main reference and every directional anchor derive from this sheet.
            </p>
            {turnaroundUnlockConfirming ? (
              <div className="mt-3 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-[11px]">
                <p className="text-port-warning">
                  Reopen the turnaround, main, all 8 anchors, and every approved {anchorSeededPhrase}? Existing versioned files stay in history.
                </p>
                <ConfirmButtonPair
                  className="mt-2 flex-wrap"
                  confirmText="Unlock for regeneration"
                  confirmIcon={Unlock}
                  tone="warning"
                  busy={turnaroundUnlocking}
                  busyText="Unlocking…"
                  ariaLabel="Confirm unlock turnaround"
                  onConfirm={unlockTurnaround}
                  onCancel={() => setTurnaroundUnlockConfirming(false)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setTurnaroundUnlockConfirming(true)}
                disabled={turnaroundUnlocking}
                className="mt-3 flex min-h-9 w-full items-center justify-center gap-1.5 rounded border border-port-border bg-port-card px-2.5 py-1.5 text-xs text-gray-300 hover:border-port-warning hover:text-port-warning disabled:opacity-50"
              >
                <Unlock className="h-3.5 w-3.5" /> Unlock turnaround
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={`grid items-start gap-4 ${turnaroundCandidates.length > 0 ? '@3xl:grid-cols-[minmax(17rem,0.72fr)_minmax(20rem,1.28fr)]' : ''}`}>
          <div className="min-w-0 space-y-3">
            <p className="text-[11px] leading-relaxed text-gray-500">
              {backfillOptional
                ? 'This character predates turnaround sheets and its reference set is already complete, so a sheet won’t change any locked artifact. Generating one is optional — it only gives future forks of this character all four sides to work from.'
                : backfilling
                  ? 'This character was built before turnaround sheets. Generate one from its locked main reference — the remaining directional anchors will be drawn from it, so accessories stay on the same side of the body.'
                  : 'One image, four views (front · right · back · left). Every later render is redrawn from it, so a bag or pocket keeps the same anatomical side from every angle.'}
            </p>

            <div>
              <label htmlFor="sprite-turnaround-design-prompt" className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-gray-500">
                Character design
              </label>
              <textarea
                id="sprite-turnaround-design-prompt"
                value={designPrompt}
                onChange={(e) => setDesignPrompt(e.target.value)}
                placeholder="Describe the character (or attach a design reference image)…"
                rows={4}
                className="w-full resize-y rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
              />
            </div>

            <TurnaroundReferenceInput
              refSource={refSource}
              pickUpload={pickUpload}
              strength={strength}
              setStrength={setStrength}
              clearSource={clearSource}
              setGalleryOpen={setGalleryOpen}
              setSpritePickerOpen={setSpritePickerOpen}
            />

            <div className="flex flex-col gap-2 border-t border-port-border pt-3 sm:flex-row sm:flex-wrap sm:items-end">
              {modePicker}
              <button
                type="button"
                onClick={() => generate('turnaround')}
                disabled={!mode || !!pendingJobs.turnaround || (!designPrompt.trim() && !refSource && !backfilling)}
                className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {pendingJobs.turnaround ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {pendingJobs.turnaround ? 'Rendering…'
                  : backfilling ? 'Generate from locked main'
                    : turnaroundCandidates.length ? 'Regenerate' : 'Generate candidate'}
              </button>
            </div>
          </div>

          {turnaroundCandidates.length > 0 && (
            <div className="min-w-0 rounded-lg border border-port-border bg-port-bg p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h5 className="text-xs font-semibold text-gray-300">Candidate review</h5>
                  <p className="mt-0.5 text-[10px] text-gray-500">Inspect at full size, then freeze the identity you want to keep.</p>
                </div>
                <span className="rounded-full border border-port-border px-2 py-0.5 text-[10px] text-gray-500">
                  {turnaroundCandidates.length}
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
                {turnaroundCandidates.map((candidate) => (
                  <CandidateTile
                    key={candidate.path}
                    recordId={recordId}
                    candidate={candidate}
                    locking={locking}
                    clipRisk={clipRisks[candidate.path]}
                    onLock={(picked, accept) => lock('turnaround', picked, accept)}
                    correction={turnaroundCorrections[candidate.path]}
                    onCorrectionChange={(value) => setTurnaroundCorrections((prev) => ({ ...prev, [candidate.path]: value }))}
                    onReprocess={() => reprocessTurnaround(candidate)}
                    reprocessing={Boolean(pendingJobs.turnaround)}
                    canReprocess={Boolean(mode)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
