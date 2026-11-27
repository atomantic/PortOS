// Reference workflow (issues #2896, #2979): three ordered steps — generate a
// turnaround sheet from text + an optional design image and freeze it, derive
// and freeze the main (walk-south) from that sheet, then derive + lock the 8
// directional anchors, each redrawn from the sheet's panel for that side. The
// manifest (server-owned) is the source of truth for status; this component
// only renders it and fires the generate/lock/override actions.

import { useEffect, useMemo, useState } from 'react';
import toast from '../ui/Toast';
import { generateSpriteReference, lockSpriteReference, unlockSpriteReferenceAnchor, unlockSpriteMainReference, unlockSpriteTurnaround, updateSpriteRecord } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import SpriteReferencePicker from './SpriteReferencePicker.jsx';
import ForkSpriteModal from './ForkSpriteModal.jsx';
import { correctionPromptPayload, anchorCorrectionKey, MAIN_CORRECTION_KEY } from './CorrectionNote.jsx';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow.jsx';
import ListLoadError from '../ui/ListLoadError.jsx';
import { ReferenceWorkflowHeader } from './ReferenceStagePrimitives';
import DirectionalAnchorsStage from './DirectionalAnchorsStage';
import MainAnchorStage from './MainAnchorStage';
import TurnaroundStage from './TurnaroundStage';

// Lock confirmations for the two directionless identity artifacts; every other
// target is a named direction.
const LOCK_TOAST = { turnaround: 'Turnaround sheet frozen', main: 'Main reference frozen' };

export default function ReferenceWorkflow({
  record, reference, renders, corrections, onCorrectionChange, backends, trackDefinitions, mode, onModeChange, onChanged, onForked,
  backendsError = null, onRetryBackends = null,
}) {
  const recordId = record.id;
  // Local shadow of record.imageModelId (#3231 Phase 3) — pin PATCHes update
  // this directly instead of refetching the whole detail payload; re-seeded
  // when the user switches records.
  const [modelPin, setModelPin] = useState(record.imageModelId || null);
  useEffect(() => { setModelPin(record.imageModelId || null); }, [recordId, record.imageModelId]);
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
  // What a reference reopen actually drops, named from THIS record's registry
  // slice rather than as literal copy. The old wording said "walk/scanner",
  // which was already wrong twice over since #3152 made every non-walk track
  // user-defined: an install whose user deleted the seeded `scanner` row was
  // warned about an animation it does not have, and one who authored a track of
  // their own was not warned about the approvals they were about to lose.
  //
  // Directional is the client-side spelling of the server's `sourceReferenceFor`
  // === 'anchor' (a per-facing track must seed from that facing's own anchor) —
  // which is exactly the set `invalidateAnchorDependentTracks` sweeps, so this
  // sentence and the invalidation it describes cannot drift.
  const anchorSeededLabels = useMemo(() => (trackDefinitions || [])
    .filter((row) => row.directional)
    .map((row) => row.label.toLowerCase()), [trackDefinitions]);
  // Falls back to the generic noun when the record carries no directional track
  // (or the caller passed no definitions) rather than rendering an empty list.
  const anchorSeededPhrase = anchorSeededLabels.length
    ? anchorSeededLabels.join(' / ')
    : 'animations';
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
    // Same per-track map the main unlock reads below — `unlockDirectionalAnchor`
    // sweeps every anchor-seeded track for this facing, not just walk, so a toast
    // that reads only `walkInvalidated` under-reports what it just dropped.
    const tracksReopened = Object.values(result.tracksInvalidated || {}).some(Boolean);
    toast.success(result.walkInvalidated || tracksReopened
      ? `${direction} anchor unlocked; its animations were reopened`
      : `${direction} anchor unlocked`);
    onChanged();
  }, { errorMessage: 'Failed to unlock anchor' });

  const [unlockMain, mainUnlocking] = useAsyncAction(async () => {
    const result = await unlockSpriteMainReference(recordId, { silent: true });
    // Read the per-track MAP, not the legacy `scannerInvalidated` alias (#3152):
    // every non-walk track is user-defined now, so a user who deleted `scanner` and
    // added their own anchor-seeded track would otherwise be told nothing was
    // reopened while their approvals had in fact been dropped.
    const tracksReopened = Object.values(result.tracksInvalidated || {}).some(Boolean);
    toast.success(result.walkInvalidated || tracksReopened
      ? 'Main reference unlocked; its south animations were reopened'
      : 'Main reference unlocked; ready to regenerate from the turnaround');
    setMainUnlockConfirming(false);
    onChanged();
  }, { errorMessage: 'Failed to unlock main reference' });

  const [unlockTurnaround, turnaroundUnlocking] = useAsyncAction(async () => {
    const result = await unlockSpriteTurnaround(recordId, { silent: true });
    // A turnaround reopen resets the whole identity chain, so the server sweeps
    // EVERY anchor-seeded track across every facing (`tracksInvalidatedDirections`)
    // alongside walk. Count the reopened facings across all of them rather than
    // reporting walk's alone — a record whose user deleted `walk`'s seeded
    // companions, or added their own, otherwise sees a number that doesn't match
    // the cards that just went back to draft.
    const trackDirections = Object.values(result.tracksInvalidatedDirections || {})
      .reduce((total, directions) => total + (directions?.length || 0), 0);
    const invalidated = (result.walkInvalidatedDirections?.length || 0) + trackDirections;
    toast.success(invalidated
      ? `Turnaround unlocked; ${invalidated} dependent ${invalidated === 1 ? 'animation was' : 'animations were'} reopened`
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
  // Backend + model picker, persisted onto THIS record as its render pin
  // (#3231 Phase 3) so re-rolls and future sessions render where the user
  // chose. `modelPin` shadows record.imageModelId locally — the PATCH already
  // holds the new value, so no detail refetch is needed (the useUniverseDraft
  // setRenderPin pattern).
  const modePicker = Array.isArray(backends) && backends.length > 0 && (
    <RecordRenderPinRow
      idPrefix={`sprite-render-pin-${recordId}`}
      label="Backend"
      imageMode={mode}
      imageModelId={modelPin}
      options={backends}
      showAuto={false}
      onChange={({ imageMode, imageModelId }) => {
        if (imageMode && imageMode !== mode) onModeChange(imageMode);
        setModelPin(imageModelId);
        updateSpriteRecord(recordId, { imageMode, imageModelId }, { silent: true })
          .catch((err) => toast.error(`Render pin save failed: ${err.message}`));
      }}
    />
  );
  const turnaroundCandidates = candidatesByTarget.turnaround || [];
  const mainCandidates = candidatesByTarget.main || [];

  const referenceInput = {
    refSource, pickUpload, strength, setStrength, clearSource, setGalleryOpen, setSpritePickerOpen,
  };

  return (
    <div className="@container space-y-4 rounded-lg border border-port-border bg-port-card p-3 sm:p-4">
      <ReferenceWorkflowHeader
        manifest={manifest}
        turnaroundLocked={turnaroundLocked}
        mainLocked={mainLocked}
        backfillOptional={backfillOptional}
        turnaroundCandidates={turnaroundCandidates}
        anchorProgress={anchorProgress}
        allAnchorsLocked={allAnchorsLocked}
        keyFrozen={keyFrozen}
        setChromaKey={setChromaKey}
        keySaving={keySaving}
        record={record}
      />
      {manifest?.chromaKeyWarning && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          {manifest.chromaKeyWarning}
        </p>
      )}
      {backendsError && (
        <ListLoadError what="image backends" error={backendsError} onRetry={onRetryBackends} />
      )}
      {!backendsError && noBackend && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          No image backend configured — enable Codex or Grok, or set a local Python path, in Media Gen Settings to generate references.
        </p>
      )}

      <div className="grid items-start gap-4 @5xl:grid-cols-[minmax(0,1.65fr)_minmax(19rem,0.75fr)]">
        {/* Step 1 — the turnaround sheet, the identity root every later render
            descends from. On desktop, design controls and candidate review sit
            beside each other instead of leaving the right side of the panel
            empty; below that breakpoint they preserve the guided linear flow. */}
        <TurnaroundStage
          recordId={recordId}
          manifest={manifest}
          turnaroundLocked={turnaroundLocked}
          backfilling={backfilling}
          backfillOptional={backfillOptional}
          turnaroundUnlockConfirming={turnaroundUnlockConfirming}
          setTurnaroundUnlockConfirming={setTurnaroundUnlockConfirming}
          turnaroundUnlocking={turnaroundUnlocking}
          unlockTurnaround={unlockTurnaround}
          anchorSeededPhrase={anchorSeededPhrase}
          turnaroundCandidates={turnaroundCandidates}
          designPrompt={designPrompt}
          setDesignPrompt={setDesignPrompt}
          referenceInput={referenceInput}
          modePicker={modePicker}
          mode={mode}
          pendingJobs={pendingJobs}
          generate={generate}
          locking={locking}
          clipRisks={clipRisks}
          lock={lock}
          turnaroundCorrections={turnaroundCorrections}
          setTurnaroundCorrections={setTurnaroundCorrections}
          reprocessTurnaround={reprocessTurnaround}
        />

        {/* Step 2 stays visible beside the active turnaround workspace on wide
            screens. At narrower widths it follows step 1 in reading order. */}
        <MainAnchorStage
          recordId={recordId}
          manifest={manifest}
          mainLocked={mainLocked}
          turnaroundLocked={turnaroundLocked}
          mainUnlockConfirming={mainUnlockConfirming}
          setMainUnlockConfirming={setMainUnlockConfirming}
          mainUnlocking={mainUnlocking}
          unlockMain={unlockMain}
          anchorSeededPhrase={anchorSeededPhrase}
          setForkOpen={setForkOpen}
          modePicker={modePicker}
          mode={mode}
          pendingJobs={pendingJobs}
          generate={generate}
          mainCandidates={mainCandidates}
          corrections={corrections}
          onCorrectionChange={onCorrectionChange}
          locking={locking}
          clipRisks={clipRisks}
          lock={lock}
        />
      </div>

      {/* Step 3 spans the workspace because active anchors need repeatable card
          width. A complete set stays collapsed and compact by default. */}
      {mainLocked && (
        <DirectionalAnchorsStage
          manifest={manifest}
          recordId={recordId}
          allAnchorsLocked={allAnchorsLocked}
          anchorProgress={anchorProgress}
          turnaroundLocked={turnaroundLocked}
          anchorsOpen={anchorsOpen}
          setAnchorsOpen={setAnchorsOpen}
          modePicker={modePicker}
          candidatesByTarget={candidatesByTarget}
          anchorUnlocking={anchorUnlocking}
          unlockAnchor={unlockAnchor}
          corrections={corrections}
          onCorrectionChange={onCorrectionChange}
          generate={generate}
          mode={mode}
          pendingJobs={pendingJobs}
          locking={locking}
          clipRisks={clipRisks}
          lock={lock}
        />
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
