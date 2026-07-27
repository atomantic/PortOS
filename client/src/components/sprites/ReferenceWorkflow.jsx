import { useEffect, useMemo, useState } from 'react';
import {
  Lock, Sparkles, RefreshCw, Upload, ChevronDown, ChevronRight,
  Images, PersonStanding, GitFork, Unlock, X,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  generateSpriteReference, lockSpriteReference,
  unlockSpriteReferenceAnchor, unlockSpriteMainReference, unlockSpriteTurnaround, updateSpriteRecord,
} from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import SpritePreview from './SpritePreview.jsx';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import SpriteReferencePicker from './SpriteReferencePicker.jsx';
import ForkSpriteModal from './ForkSpriteModal.jsx';
import CorrectionNote, {
  CorrectionNoteToggle, correctionPromptPayload, anchorCorrectionKey, MAIN_CORRECTION_KEY,
} from './CorrectionNote.jsx';
import FilePickerButton from '../ui/FilePickerButton';
import { IMAGE_ACCEPT } from '../../utils/fileUpload';

// Reference workflow (issues #2896, #2979): three ordered steps — generate a
// turnaround sheet from text + an optional design image and freeze it, derive
// and freeze the main (walk-south) from that sheet, then derive + lock the 8
// directional anchors, each redrawn from the sheet's panel for that side. The
// manifest (server-owned) is the source of truth for status; this component
// only renders it and fires the generate/lock/override actions.

// Mirrors server/services/sprites/chromaKey.js CHROMA_KEYS (client can't
// import server modules).
const CHROMA_KEYS = ['#FF00FF', '#00FF00', '#0000FF'];

// Lock confirmations for the two directionless identity artifacts; every other
// target is a named direction.
const LOCK_TOAST = { turnaround: 'Turnaround sheet frozen', main: 'Main reference frozen' };

// Thin alias so the existing call sites keep their `className` semantics
// (sizing on the box) while the checkerboard + pixelation rules live in one
// place — see SpritePreview. Every reference-set image is click-to-enlarge
// (zoomable) — the main reference, locked anchors, and candidate tiles all open
// a SpriteLightbox on click, since none of them live in the asset browser that
// has its own inspector.
function SpriteImg({ recordId, path, className }) {
  return <SpritePreview recordId={recordId} path={path} className={className} zoomable />;
}

// Candidate thumbnail with an inline lock confirm. Locking freezes this
// version and its downstream workflow until the relevant explicit unlock, so
// the consequential action stays visible in an inline confirm row.
function CandidateTile({ recordId, candidate, locking, onLock, clipRisk, correction, onCorrectionChange, onReprocess, reprocessing, canReprocess = true }) {
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
        <div className="mt-auto flex flex-wrap items-center gap-1 text-xs">
          <span className="text-port-warning">Freeze this version?</span>
          <button onClick={() => { setConfirming(false); onLock(candidate); }} disabled={locking} className="px-1.5 py-0.5 bg-port-accent text-white rounded disabled:opacity-50">Lock</button>
          <button onClick={() => setConfirming(false)} className="px-1.5 py-0.5 text-gray-400 hover:text-white">Cancel</button>
        </div>
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
function LockedAnchor({ recordId, anchor, canUnlock, unlocking, onUnlock }) {
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
          <div className="flex gap-1">
            <button
              type="button"
              aria-label={`Confirm unlock ${direction} anchor`}
              onClick={() => { setConfirming(false); onUnlock(direction); }}
              disabled={unlocking}
              className="flex-1 rounded bg-port-warning px-1.5 py-1 font-medium text-black disabled:opacity-50"
            >
              Unlock
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={unlocking}
              className="rounded px-1.5 py-1 text-gray-400 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
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

function StageHeading({ id, number, title, status, statusTone = 'text-gray-500' }) {
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

export default function ReferenceWorkflow({ record, reference, renders, corrections, onCorrectionChange, backends, mode, onModeChange, onChanged, onForked }) {
  const recordId = record.id;
  const manifest = reference?.manifest || null;
  const candidates = reference?.candidates || [];
  const mainLocked = manifest?.mainReference?.locked === true;
  // Turnaround-first (#2979): the sheet is step 1 and the identity root — the
  // main is its front view and every anchor is redrawn from the panel showing
  // that side. A character created before this shows the same three steps with
  // step 1 as a backfill from its already-locked main.
  const turnaroundLocked = manifest?.turnaround?.locked === true;
  const backfilling = mainLocked && !turnaroundLocked;
  // Whichever lock froze the canonical key closes the pin control.
  const keyFrozen = mainLocked || turnaroundLocked;
  // Once every anchor is locked this grid is just static previews of files the
  // "Reference set" file browser below already lists (and makes inspectable /
  // downloadable), so it reads as duplicate content. Collapse it by default
  // when complete — the grid stays the authoritative surface WHILE you're
  // generating/locking, and the browser stays the one place to inspect the
  // frozen files. Toggle re-arms per character; a mid-session lock leaves the
  // grid as the user left it.
  const anchorList = manifest?.anchors || [];
  const allAnchorsLocked = anchorList.length > 0 && anchorList.every((a) => a.status === 'locked');
  const lockedAnchorCount = anchorList.filter((a) => a.status === 'locked').length;
  const anchorProgress = anchorList.length > 0
    ? `${lockedAnchorCount}/${anchorList.length} locked`
    : 'Waiting for main';
  // A legacy character with every anchor already frozen has nothing left for a
  // sheet to improve — main and anchors are immutable — so the backfill stops
  // being a step it's missing and becomes an optional extra that only helps
  // future forks. Present it that way instead of nagging forever.
  const backfillOptional = backfilling && allAnchorsLocked;
  const [anchorsOpen, setAnchorsOpen] = useState(!allAnchorsLocked);
  // Reset the default on record switch only (deps: recordId), so it never
  // fights a user toggle within one character. The per-direction correction
  // text is now page-owned (#2964) and reset there on record switch, so this
  // effect no longer clears it.
  useEffect(() => { setAnchorsOpen(!allAnchorsLocked); }, [recordId]);

  // Image-backend availability + the selected `mode` are page-owned (#2938) so
  // that the Sprites page's asset-card Regenerate re-rolls through the SAME
  // backend this picker drives (a per-component fetch would let the two
  // diverge). `backends`: null = settings not loaded yet; [] = loaded, no
  // backend configured.
  const [designPrompt, setDesignPrompt] = useState(manifest?.designPrompt || '');
  // The main render can be seeded (image+text→image) from one of three sources:
  // an uploaded file, a pick from the render-history gallery, or another sprite's
  // locked main reference. One unified `refSource` holds whichever is active so
  // the generate payload and the preview stay in sync.
  //   null | { type:'upload', file, previewUrl }
  //        | { type:'gallery', filename, previewUrl, label }
  //        | { type:'sprite', id, name, path }
  const [refSource, setRefSource] = useState(null);
  const [strength, setStrength] = useState(0.65);
  // Per-direction free-text correction re-appended to an anchor re-roll (e.g.
  // "no pocket on the right sleeve"). Keyed by direction because the anchor
  // grid renders all directions at once — unlike the single main designPrompt.
  // Page-owned (#2964) and passed in as `corrections` / `onCorrectionChange` so
  // this grid and the asset-collection Regenerate button share one source: a
  // note typed on either surface is visible on the other and rides the re-roll.
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [spritePickerOpen, setSpritePickerOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [mainUnlockConfirming, setMainUnlockConfirming] = useState(false);
  const [turnaroundUnlockConfirming, setTurnaroundUnlockConfirming] = useState(false);
  const [turnaroundCorrections, setTurnaroundCorrections] = useState({});
  useEffect(() => {
    setMainUnlockConfirming(false);
    setTurnaroundUnlockConfirming(false);
  }, [recordId]);
  useEffect(() => { setTurnaroundCorrections({}); }, [recordId]);

  // Revoke the previous upload's object URL whenever the source changes or the
  // component unmounts (cleanup runs with the prior closure).
  useEffect(() => {
    const url = refSource?.type === 'upload' ? refSource.previewUrl : null;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [refSource]);

  const clearSource = () => setRefSource(null);
  const pickUpload = (file) => {
    if (!file) return;
    setRefSource({ type: 'upload', file, previewUrl: URL.createObjectURL(file) });
  };
  // target → jobId for in-flight renders. Owned by the Sprites page and shared
  // with the asset collection's anchor Regenerate buttons (#2931) so both gate
  // on one map — see the matching note in WalkWorkflow.
  const { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit } = renders;

  const candidatesByTarget = useMemo(() => candidates.reduce((acc, c) => {
    const t = c.target || 'main';
    (acc[t] ||= []).push(c);
    return acc;
  }, {}), [candidates]);

  const generate = async (target) => {
    beginSubmit(target);
    try {
      const { jobId } = await generateSpriteReference(recordId, {
        target,
        ...(mode ? { mode } : {}),
        // The sheet owns the design inputs; the main derives from it with no
        // design inputs of its own; anchors carry only their correction note.
        // The main and every anchor DO carry a correction (#3134/#2964) — under
        // their own key in the shared map, so a main note can't ride an anchor.
        ...(target === 'turnaround' ? {
          designPrompt,
          ...(refSource?.type === 'upload' ? { referenceImageFile: refSource.file } : {}),
          ...(refSource?.type === 'gallery' ? { initImageGalleryFile: refSource.filename } : {}),
          ...(refSource?.type === 'sprite' ? { initImageSpriteId: refSource.id } : {}),
          ...(refSource ? { initImageStrength: strength } : {}),
        } : target === 'main'
          ? correctionPromptPayload(corrections, MAIN_CORRECTION_KEY)
          : correctionPromptPayload(corrections, anchorCorrectionKey(target))),
      }, { silent: true });
      resolveSubmit(target, jobId);
      if (target === 'turnaround') clearSource();
    } catch (err) {
      cancelSubmit(target);
      toast.error(err?.message || `Failed to queue ${target} render`);
    }
  };

  const reprocessTurnaround = async (candidate) => {
    const correctionPrompt = turnaroundCorrections[candidate.path]?.trim();
    if (!correctionPrompt) return;
    beginSubmit('turnaround');
    try {
      const { jobId } = await generateSpriteReference(recordId, {
        target: 'turnaround',
        ...(mode ? { mode } : {}),
        initImageCandidate: candidate.path,
        correctionPrompt,
      }, { silent: true });
      resolveSubmit('turnaround', jobId);
    } catch (err) {
      cancelSubmit('turnaround');
      toast.error(err?.message || 'Failed to re-process turnaround');
    }
  };

  // path → clip-risk message; a risky main lock 409s until the user
  // explicitly locks through it from the candidate tile.
  const [clipRisks, setClipRisks] = useState({});

  const [lock, locking] = useAsyncAction(async (target, candidate, acceptClipRisk = false) => {
    try {
      await lockSpriteReference(recordId, {
        target, candidate: candidate.path, ...(acceptClipRisk ? { acceptClipRisk: true } : {}),
      }, { silent: true });
    } catch (err) {
      if (err?.code === 'CHROMA_CLIP_RISK') {
        setClipRisks((prev) => ({ ...prev, [candidate.path]: err.message }));
        return;
      }
      throw err; // useAsyncAction toasts
    }
    setClipRisks((prev) => {
      const next = { ...prev };
      delete next[candidate.path];
      return next;
    });
    toast.success(LOCK_TOAST[target] || `Anchor ${target} locked`);
    onChanged();
  }, { errorMessage: 'Lock failed' });

  const [unlockAnchor, anchorUnlocking] = useAsyncAction(async (direction) => {
    const result = await unlockSpriteReferenceAnchor(
      recordId,
      { direction },
      { silent: true },
    );
    toast.success(result.walkInvalidated
      ? `${direction} anchor unlocked; its walk was reopened`
      : `${direction} anchor unlocked`);
    onChanged();
  }, { errorMessage: 'Failed to unlock anchor' });

  const [unlockMain, mainUnlocking] = useAsyncAction(async () => {
    const result = await unlockSpriteMainReference(recordId, { silent: true });
    toast.success(result.walkInvalidated || result.scannerInvalidated
      ? 'Main reference unlocked; its south animations were reopened'
      : 'Main reference unlocked; ready to regenerate from the turnaround');
    setMainUnlockConfirming(false);
    onChanged();
  }, { errorMessage: 'Failed to unlock main reference' });

  const [unlockTurnaround, turnaroundUnlocking] = useAsyncAction(async () => {
    const result = await unlockSpriteTurnaround(recordId, { silent: true });
    const invalidated = result.walkInvalidatedDirections?.length || 0;
    toast.success(invalidated
      ? `Turnaround unlocked; ${invalidated} dependent walks were reopened`
      : 'Turnaround unlocked; dependent references were reopened');
    setTurnaroundUnlockConfirming(false);
    onChanged();
  }, { errorMessage: 'Failed to unlock turnaround' });

  const [setChromaKey, keySaving] = useAsyncAction(async (hex) => {
    await updateSpriteRecord(recordId, { chromaKey: hex }, { silent: true });
    // A key change invalidates any clip-risk warning the user was shown —
    // force a fresh 409/confirm cycle instead of letting a stale "Lock
    // anyway" accept a risk computed for the old key.
    setClipRisks({});
    onChanged();
  }, { errorMessage: 'Failed to set chroma key' });

  const noBackend = Array.isArray(backends) && backends.length === 0;
  const modePicker = Array.isArray(backends) && backends.length > 0 && (
    <label className="flex items-center gap-2 text-xs text-gray-400">
      Backend
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
      >
        {backends.map((b) => <option key={b.id} value={b.id}>{b.label || b.id}</option>)}
      </select>
    </label>
  );
  const turnaroundCandidates = candidatesByTarget.turnaround || [];
  const mainCandidates = candidatesByTarget.main || [];

  return (
    <div className="@container space-y-4 rounded-lg border border-port-border bg-port-card p-3 sm:p-4">
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
            className={`h-6 rounded-sm border px-2 text-[10px] ${!record.chromaKey ? 'border-white ring-1 ring-port-accent text-white' : 'border-port-border text-gray-400 opacity-60 hover:opacity-100'} disabled:opacity-40`}
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

      {manifest?.chromaKeyWarning && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          {manifest.chromaKeyWarning}
        </p>
      )}
      {noBackend && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          No image backend configured — enable Codex or Grok, or set a local Python path, in Settings → Image Gen to generate references.
        </p>
      )}

      <div className="grid items-start gap-4 @5xl:grid-cols-[minmax(0,1.65fr)_minmax(19rem,0.75fr)]">
        {/* Step 1 — the turnaround sheet, the identity root every later render
            descends from. On desktop, design controls and candidate review sit
            beside each other instead of leaving the right side of the panel
            empty; below that breakpoint they preserve the guided linear flow. */}
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
                      Reopen the turnaround, main, all 8 anchors, and any approved walks? Existing versioned files stay in history.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        aria-label="Confirm unlock turnaround"
                        onClick={unlockTurnaround}
                        disabled={turnaroundUnlocking}
                        className="flex-1 rounded bg-port-warning px-2 py-1.5 font-medium text-black disabled:opacity-50"
                      >
                        {turnaroundUnlocking ? 'Unlocking…' : 'Unlock for regeneration'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTurnaroundUnlockConfirming(false)}
                        disabled={turnaroundUnlocking}
                        className="rounded px-2 py-1.5 text-gray-400 hover:text-white disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
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

                {/* Reference image (optional, i2i seed) — pick ONE of three sources. */}
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
                      className="shrink-0 p-1 text-gray-400 hover:text-white"
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

        {/* Step 2 stays visible beside the active turnaround workspace on wide
            screens. At narrower widths it follows step 1 in reading order. */}
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
                      Reopen the main reference and its south walk/scanner? The turnaround and other directions stay locked; existing files remain in history.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        aria-label="Confirm unlock main reference"
                        onClick={unlockMain}
                        disabled={mainUnlocking}
                        className="flex-1 rounded bg-port-warning px-2 py-1.5 font-medium text-black disabled:opacity-50"
                      >
                        {mainUnlocking ? 'Unlocking…' : 'Unlock for regeneration'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMainUnlockConfirming(false)}
                        disabled={mainUnlocking}
                        className="rounded px-2 py-1.5 text-gray-400 hover:text-white disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
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
      </div>

      {/* Step 3 spans the workspace because active anchors need repeatable card
          width. A complete set stays collapsed and compact by default. */}
      {mainLocked && (
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
      )}

      {/* Reference-image source pickers + fork. Portal-based modals, so their
          placement in the tree doesn't matter. */}
      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onSelect={(item) => setRefSource({
          type: 'gallery', filename: item.filename, previewUrl: item.previewUrl, label: item.prompt || item.filename,
        })}
      />
      <SpriteReferencePicker
        open={spritePickerOpen}
        onClose={() => setSpritePickerOpen(false)}
        excludeId={recordId}
        onSelect={(it) => setRefSource({ type: 'sprite', id: it.id, name: it.name, path: it.path })}
      />
      {mainLocked && (
        <ForkSpriteModal
          open={forkOpen}
          onClose={() => setForkOpen(false)}
          source={{ id: recordId, name: record.name }}
          // Preview exactly what the fork will attach: the server's
          // lockedSeedArtifact prefers the sheet over the main.
          referencePath={turnaroundLocked ? manifest.turnaround.path : manifest.mainReference.path}
          fromTurnaround={turnaroundLocked}
          backends={backends}
          mode={mode}
          onForked={(rec) => onForked?.(rec)}
        />
      )}
    </div>
  );
}
