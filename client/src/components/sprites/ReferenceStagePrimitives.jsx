import { useState } from 'react';
import { Lock, Sparkles, RefreshCw, Unlock } from 'lucide-react';
import SpritePreview from './SpritePreview.jsx';
import CorrectionNote from './CorrectionNote.jsx';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';

// Mirrors server/services/sprites/chromaKey.js CHROMA_KEYS (client can't
// import server modules).
const CHROMA_KEYS = ['#FF00FF', '#00FF00', '#0000FF'];


// Thin alias so the existing call sites keep their `className` semantics
// (sizing on the box) while the checkerboard + pixelation rules live in one
// place — see SpritePreview. Every reference-set image is click-to-enlarge
// (zoomable) — the main reference, locked anchors, and candidate tiles all open
// a SpriteLightbox on click, since none of them live in the asset browser that
// has its own inspector.
export function SpriteImg({ recordId, path, className }) {
  return <SpritePreview recordId={recordId} path={path} className={className} zoomable />;
}

// Candidate thumbnail with an inline lock confirm. Locking freezes this
// version and its downstream workflow until the relevant explicit unlock, so
// the consequential action stays visible in an inline confirm row.
export function CandidateTile({ recordId, candidate, locking, onLock, clipRisk, correction, onCorrectionChange, onReprocess, reprocessing, canReprocess = true }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-port-border bg-port-card p-2">
      <SpriteImg
        recordId={recordId}
        path={candidate.path}
        className="w-full aspect-square rounded-md border border-port-border object-contain"
      />
      <p className="truncate px-0.5 text-[10px] text-gray-500" title={candidate.path}>
        {candidate.path.split('/').pop()}{candidate.mode ? ` · ${candidate.mode}` : ''}
      </p>
      {candidate.target === 'turnaround' && onCorrectionChange && (
        <CorrectionNote
          direction={candidate.path}
          value={correction}
          onValueChange={onCorrectionChange}
          ariaLabel="Correction guidance for this turnaround attempt"
          placeholder="Correction for this attempt, e.g. add the missing sleeve pocket"
          className="text-[10px]"
        />
      )}
      {candidate.target === 'turnaround' && onReprocess && (
        <button
          type="button"
          onClick={onReprocess}
          disabled={!canReprocess || reprocessing || !correction?.trim()}
          title="Render this turnaround again with the correction note"
          className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${reprocessing ? 'animate-spin' : ''}`} />
          {reprocessing ? 'Re-processing…' : 'Re-process with note'}
        </button>
      )}
      {clipRisk ? (
        <div className="mt-auto space-y-1 text-[10px]">
          <p className="text-port-warning">{clipRisk}</p>
          <button
            onClick={() => onLock(candidate, true)}
            disabled={locking}
            className="w-full rounded border border-port-warning bg-port-warning/20 px-1.5 py-1 text-xs text-port-warning disabled:opacity-50"
          >
            Lock anyway
          </button>
        </div>
      ) : confirming ? (
        <ConfirmButtonPair
          className="mt-auto flex-wrap"
          prompt="Freeze this version?"
          confirmText="Lock"
          confirmIcon={Lock}
          tone="success"
          busy={locking}
          busyText="Locking…"
          ariaLabel={`Confirm lock ${candidate.target || 'candidate'}`}
          onConfirm={() => { setConfirming(false); onLock(candidate); }}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={locking}
          className="mt-auto flex w-full items-center justify-center gap-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-gray-300 hover:border-port-accent disabled:opacity-50"
        >
          <Lock className="w-3 h-3" /> Lock
        </button>
      )}
    </div>
  );
}

// A directional-anchor unlock is deliberately narrower than unlocking the
// identity root: it preserves the old versioned PNG, reopens this card, and
// invalidates only the walk that depended on it. Keep the consequential action
// behind the same inline-confirm convention as locking.
export function LockedAnchor({ recordId, anchor, canUnlock, unlocking, onUnlock }) {
  const [confirming, setConfirming] = useState(false);
  const direction = anchor.direction;
  return (
    <div className="space-y-2">
      <SpriteImg
        recordId={recordId}
        path={anchor.path}
        className="w-full aspect-square rounded border border-port-border object-contain"
      />
      {canUnlock && (confirming ? (
        <div className="rounded border border-port-warning/40 bg-port-warning/10 p-1.5 text-[10px]">
          <p className="mb-1.5 text-port-warning">Regenerate {direction} from turnaround?</p>
          <ConfirmButtonPair
            className="flex-wrap"
            confirmText="Unlock"
            confirmIcon={Unlock}
            tone="warning"
            busy={unlocking}
            busyText="Unlocking…"
            ariaLabel={`Confirm unlock ${direction} anchor`}
            onConfirm={() => { setConfirming(false); onUnlock(direction); }}
            onCancel={() => setConfirming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Unlock ${direction} anchor`}
          onClick={() => setConfirming(true)}
          disabled={unlocking}
          className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-port-border bg-port-card px-2 py-1 text-xs text-gray-400 hover:border-port-warning hover:text-port-warning disabled:opacity-50"
        >
          <Unlock className="h-3 w-3" /> Unlock anchor
        </button>
      ))}
    </div>
  );
}

const STEP_TONE = {
  complete: 'border-port-success/40 bg-port-success/10 text-port-success',
  active: 'border-port-accent/50 bg-port-accent/10 text-port-accent',
  waiting: 'border-port-border bg-port-bg text-gray-500',
};

function StepSummary({ number, label, status, tone }) {
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 ${STEP_TONE[tone]}`}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-semibold">
        {number}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[10px] uppercase tracking-wide">{label}</span>
        <span className="block truncate text-[11px] font-medium">{status}</span>
      </span>
    </div>
  );
}

export function StageHeading({ id, number, title, status, statusTone = 'text-gray-500' }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-port-border bg-port-bg text-xs font-semibold text-gray-300">
        {number}
      </span>
      <div className="min-w-0">
        <h4 id={id} className="truncate text-xs font-semibold uppercase tracking-wide text-gray-300">{title}</h4>
        <p className={`text-[10px] ${statusTone}`}>{status}</p>
      </div>
    </div>
  );
}

export function ReferenceWorkflowHeader({
  manifest,
  turnaroundLocked,
  mainLocked,
  backfillOptional,
  turnaroundCandidates,
  anchorProgress,
  allAnchorsLocked,
  keyFrozen,
  setChromaKey,
  keySaving,
  record,
}) {
  return (
      <div className="flex flex-col gap-3 @4xl:flex-row @4xl:items-start">
        <div className="min-w-[13rem] flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white">
            <Sparkles className="h-4 w-4" /> Reference Set
            <span className="text-xs font-normal text-gray-500">{manifest?.status || 'not started'}</span>
          </h3>
          <p className="mt-1 max-w-xl text-[11px] text-gray-500">
            Establish the character once, then derive every animation from the same locked identity.
          </p>
        </div>

        <div className="grid flex-[1.4] grid-cols-1 gap-2 sm:grid-cols-3">
          <StepSummary
            number="1"
            label="Turnaround"
            status={turnaroundLocked ? 'Locked' : backfillOptional ? 'Optional backfill' : turnaroundCandidates.length > 0 ? 'Candidate ready' : 'Design'}
            tone={turnaroundLocked ? 'complete' : 'active'}
          />
          <StepSummary
            number="2"
            label="Main"
            status={mainLocked ? 'Locked' : turnaroundLocked ? 'Ready to derive' : 'Waiting'}
            tone={mainLocked ? 'complete' : turnaroundLocked ? 'active' : 'waiting'}
          />
          <StepSummary
            number="3"
            label="Anchors"
            status={anchorProgress}
            tone={allAnchorsLocked ? 'complete' : mainLocked ? 'active' : 'waiting'}
          />
        </div>

        <div
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-port-border bg-port-bg px-2.5 py-2"
          title={keyFrozen
            ? 'Chroma key is frozen with the locked reference set'
            : 'Chroma key — auto-selected when the turnaround sheet locks; pin one of the three standard keys, or auto to let the lock decide'}
        >
          <span className="mr-1 text-[10px] uppercase tracking-wide text-gray-500">Chroma key</span>
          <button
            type="button"
            onClick={() => setChromaKey(null)}
            disabled={keySaving || keyFrozen}
            className={`h-6 rounded-sm border px-2 text-[10px] pointer-coarse:min-h-11 ${!record.chromaKey ? 'border-white ring-1 ring-port-accent text-white' : 'border-port-border text-gray-400 opacity-60 hover:opacity-100'} disabled:opacity-40`}
          >
            auto
          </button>
          {CHROMA_KEYS.map((hex) => (
            <button
              type="button"
              key={hex}
              onClick={() => setChromaKey(hex)}
              disabled={keySaving || keyFrozen}
              aria-label={`Set chroma key ${hex}`}
              className={`h-6 w-6 rounded-sm border ${record.chromaKey === hex ? 'border-white ring-1 ring-port-accent' : 'border-port-border opacity-60 hover:opacity-100'} disabled:opacity-40`}
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      </div>
  );
}
