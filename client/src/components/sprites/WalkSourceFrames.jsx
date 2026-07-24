import {
  memo, useCallback, useEffect, useMemo, useState,
} from 'react';
import {
  Film, ChevronDown, ChevronRight, RefreshCw, RotateCcw, Unlock,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  getSpriteWalkSourceFrames, extractSpriteWalkSourceFrames, postprocessSpriteWalk,
  unlockSpriteWalk, reopenSpriteWalk,
} from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import CycleTarget from './CycleTarget.jsx';
import { spriteAssetUrl, PIXELATED } from './spriteAssets.js';

// Source frames + re-derive (#2980), inside the Loop Trimmer.
//
// The trimmer can only DROP columns from an already-packed strip, so an 8-frame
// run can never become a 12-frame one there — the extra source frames were
// discarded at pack time. This panel closes that gap in the workspace where the
// user notices the problem: it shows every frame ffmpeg extracted from the run's
// clip (the ~73 raw PNGs `listSpriteAssets` deliberately hides), marks the cycle
// window the packer chose and which frames became packed columns, and re-derives
// the loop from that SAME on-disk clip at a new geometry — no new paid render.
//
// The geometry knob is the shared SET-level <CycleTarget> (#2985), not a free
// per-run range: every direction of one walk occupies the same atlas columns, so
// re-deriving one direction to a value the rest of the set doesn't share just
// recreates a ragged set from the other end (and the server would 409
// WALK_TARGET_MISMATCH anyway). Re-derive itself sends only the run id and lets
// the server adopt the pinned target — the same request WalkWorkflow's Reprocess
// makes, so a target this panel's fetch is one refetch behind on can't 409 a
// value the user never chose.

// Why a run has no frames to show. All three are real states on this install,
// and none is an error — the panel explains rather than rendering an empty grid.
// `no-source-video` takes the run's provenance because the remedy differs: an
// import needs its clip brought across, while a run generated here had its clip
// cleaned up locally and re-importing is not the answer.
const unavailableCopy = ({ reason, imported }) => ({
  'no-source-video': imported
    ? 'This run was imported without its source clip, so the packed strip is all that exists here — frames can be dropped but not added. Re-import this character to bring its clip across.'
    : 'This run\'s source clip is no longer on disk, so the packed strip is all that is left — frames can be dropped but not added. Regenerate the direction to get a new clip.',
  'raw-frames-cleaned': 'The source clip is here, but the frames extracted from it were cleaned up. They can be re-extracted from the clip — no new render.',
  'run-not-packaged': 'This direction came from a redraw cycle rather than a rendered clip, so there are no source frames behind it.',
}[reason] || 'No source frames are available for this run.');

// What the user has to do before the loop can be re-derived. Mirrors the server's
// own guards (walk.js#reDeriveLockReason) so the panel never offers an action the
// API will refuse.
const LOCK_COPY = {
  finalized: {
    text: 'The walk set is frozen. Unlocking re-opens every direction for revision; the rendered clips are kept, so re-approval is one click each.',
    action: 'Unlock set',
    prompt: 'Unlock the whole set?',
    icon: Unlock,
  },
  approved: {
    text: 'This direction is approved, and approved runs are immutable. Reopening un-approves just this direction — the rendered clip is kept, so re-approval is one click.',
    action: 'Reopen direction',
    prompt: 'Reopen this direction?',
    icon: RotateCcw,
  },
  'no-source-video': {
    text: 'The source clip for this run is not on disk, so there is nothing to re-derive the loop from.',
    action: null,
  },
};

// One raw frame. Deliberately NOT checkerboarded, unlike the trimmer's packed
// cells: these are pre-key frames that still carry the solid chroma matte, so
// there is no alpha for a checkerboard to show through — painting one behind
// them would imply a transparency they don't have.
// Memoized: the trimmer this panel lives in re-renders 12–24×/second while its
// loop preview plays, and a run holds ~73 of these.
const RawFrame = memo(function RawFrame({
  recordId, frame, inWindow, packed,
}) {
  const marks = [
    inWindow ? 'in the selected cycle window' : null,
    packed ? 'packed into the strip' : null,
  ].filter(Boolean);
  const tone = packed ? 'border-port-accent ring-1 ring-port-accent'
    : inWindow ? 'border-port-warning/70' : 'border-port-border opacity-60';
  return (
    <div
      className={`rounded overflow-hidden border ${tone}`}
      title={`source frame ${frame.index}${marks.length ? ` — ${marks.join(', ')}` : ''}`}
    >
      <img
        src={spriteAssetUrl(recordId, frame.path)}
        alt={`source frame ${frame.index}`}
        loading="lazy"
        className="w-full h-auto block"
        style={PIXELATED}
      />
      <span className="block text-center text-[10px] text-gray-500 py-0.5 tabular-nums">
        {frame.index}
      </span>
    </div>
  );
});

function WalkSourceFrames({ recordId, runId, onSaved = () => {} }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The cycle target's PUT is its own request; the re-derive below reads the
  // target server-side, so it must not fire against a value the server has not
  // persisted yet (CLAUDE.md: "in-flight saves must gate dependent actions").
  const [targetSaving, setTargetSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    // The component owns its own error UI (the line below), so the request is
    // silent — otherwise the helper toasts and this renders the same failure.
    const next = await getSpriteWalkSourceFrames(recordId, runId, { silent: true })
      .catch((err) => { setLoadError(err?.message || 'Could not read this run\'s source frames'); return null; });
    if (next) setData(next);
  }, [recordId, runId]);

  useEffect(() => {
    setData(null);
    setOpen(false);
    setConfirming(false);
    load();
  }, [load]);

  const selected = useMemo(
    () => new Set(data?.selectedSourceIndices || []),
    [data?.selectedSourceIndices],
  );

  // Every mutation refreshes BOTH this panel (its own frames/lock state) and the
  // trimmer around it (the repacked strip and its frame toggles).
  const refresh = useCallback(async () => { onSaved(); await load(); }, [onSaved, load]);

  const [redrive, redriving] = useAsyncAction(async () => {
    // Geometry deliberately NOT sent: the server adopts the set's pinned target
    // for an omitted count/fps, so the request can't 409 against a target this
    // panel's fetch is one refetch behind on (#2985) — same call WalkWorkflow's
    // Reprocess makes.
    // Report the geometry the SERVER packed (it echoes the updated run record),
    // not the target this panel last fetched — those differ exactly when another
    // surface retargeted the set, which is when a wrong number would mislead.
    const run = await postprocessSpriteWalk(recordId, { runId }, { silent: true });
    toast.success(`Re-derived from the source clip · ${run?.frameCount}f @ ${run?.fps}fps`);
    await refresh();
  }, { errorMessage: 'Could not re-derive this loop' });

  // The 'raw-frames-cleaned' remedy. Explicitly user-triggered: the read above is
  // side-effect free precisely so opening the trimmer on an imported character
  // doesn't spawn an ffmpeg decode per direction.
  const [extractFrames, extracting] = useAsyncAction(async () => {
    const next = await extractSpriteWalkSourceFrames(recordId, runId, { silent: true });
    setData(next);
    setOpen(true);
    toast.success(`Extracted ${next.frames?.length ?? 0} source frames from the clip`);
  }, { errorMessage: 'Could not extract frames from this clip' });

  const [unlock, unlocking] = useAsyncAction(async () => {
    if (data.lockReason === 'finalized') {
      await unlockSpriteWalk(recordId, { silent: true });
      toast.success('Walk set unlocked — directions are editable again');
    } else {
      await reopenSpriteWalk(recordId, { direction: data.direction }, { silent: true });
      toast.success(`Walk ${data.direction} reopened`);
    }
    await refresh();
  }, { errorMessage: 'Could not unlock this direction' });

  const busy = redriving || unlocking || targetSaving || extracting;
  // Suppressed when the unavailable line above already said the same thing (a
  // clipless run reports both `reason` and `lockReason` as the missing clip) —
  // printing the explanation twice reads like two different problems.
  const lock = data && !data.editable && !(!data.available && data.lockReason === 'no-source-video')
    ? LOCK_COPY[data.lockReason]
    : null;
  const frames = data?.frames || [];

  const sectionCls = 'bg-port-bg border border-port-border rounded p-3 space-y-3';

  if (loadError) {
    return (
      <div className={sectionCls}>
        <p className="text-xs text-port-error">
          {loadError}{' '}
          <button onClick={load} className="text-port-accent hover:underline">Retry</button>
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={sectionCls}>
        <p className="text-xs text-gray-500">Reading source frames…</p>
      </div>
    );
  }

  return (
    <div className={sectionCls}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-white flex items-center gap-1.5">
          <Film className="w-3.5 h-3.5" /> Source frames
        </h4>
        {data.available ? (
          <button
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white"
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {frames.length} source frames @ {data.extractionFps}fps
            {data.current?.frameCount ? ` · packed ${data.current.frameCount}` : ''}
          </button>
        ) : (
          <span className="text-[11px] text-gray-500">none on disk</span>
        )}
      </div>

      {!data.available && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-gray-500 leading-relaxed">
            {unavailableCopy(data)}
          </p>
          {data.reason === 'raw-frames-cleaned' && (
            <button
              onClick={extractFrames}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${extracting ? 'animate-spin' : ''}`} />
              {extracting ? 'Extracting…' : 'Extract frames from clip'}
            </button>
          )}
        </div>
      )}

      {data.available && open && (
        <>
          <p className="text-[11px] text-gray-500">
            Extracted from this run&apos;s clip at {data.extractionFps}fps
            {data.maxSourceSeconds ? ` (first ${data.maxSourceSeconds}s)` : ''}.
            {data.cycle?.windowStartFrame != null && (
              <>
                {/* windowEndFrame is the exclusive seam frame — the last frame
                    IN the cycle is the one before it, which is also what the
                    grid's marking uses. */}
                {' '}Frames {data.cycle.windowStartFrame}–{data.cycle.windowEndFrame - 1} are the
                gait cycle the packer selected (
                <span className="text-port-warning">amber</span>); the{' '}
                <span className="text-port-accent">highlighted</span> ones became the packed
                strip&apos;s columns.
              </>
            )}
            {data.cycleProvenance === 'stale' && (
              <>
                {' '}These frames were re-extracted here and don&apos;t match the ones the packed
                strip was built from, so the cycle window and packed columns aren&apos;t marked —
                re-derive to rebuild the strip from these frames.
              </>
            )}
          </p>
          <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-12 gap-1.5">
            {frames.map((frame) => (
              <RawFrame
                key={frame.index}
                recordId={recordId}
                frame={frame}
                inWindow={data.cycle?.windowStartFrame != null
                  && frame.index >= data.cycle.windowStartFrame
                  && frame.index < data.cycle.windowEndFrame}
                packed={selected.has(frame.index)}
              />
            ))}
          </div>
        </>
      )}

      {/* Re-derive. Present whenever the run has a clip behind it — the source
          grid above is context, not a precondition. The geometry knob is the
          shared set-level control, so changing it here means the same thing (and
          carries the same app-lock explanation) as changing it in the walk
          workflow; the button then repacks THIS run onto it. */}
      <div className="border-t border-port-border pt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {data.target && (
            <CycleTarget
              recordId={recordId}
              target={data.target}
              disabled={busy}
              onChanged={refresh}
              onSavingChange={setTargetSaving}
              surfaceClass="bg-port-card"
              appRetargetHint="change it in the Publish panel"
            />
          )}
          <button
            onClick={redrive}
            disabled={busy || !data.editable}
            title={data.editable
              ? 'Rebuild this loop from the clip already on disk — no new render'
              : 'This run is locked — see below'}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${redriving ? 'animate-spin' : ''}`} />
            {redriving ? 'Re-deriving…' : 'Re-derive from clip'}
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          Re-deriving repacks this run from its clip onto the set&apos;s cycle target — no AI
          call, no new render. Changing the target re-targets every direction, so the others
          will need re-deriving too.
        </p>

        {lock && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-port-warning leading-relaxed">{lock.text}</p>
            {lock.action && (confirming ? (
              <ConfirmButtonPair
                prompt={lock.prompt}
                confirmText={lock.action}
                confirmIcon={lock.icon}
                tone="warning"
                busy={unlocking}
                busyText="Working…"
                ariaLabel={`Confirm ${lock.action}`}
                onConfirm={() => { setConfirming(false); unlock(); }}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <button
                onClick={() => setConfirming(true)}
                disabled={busy}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
              >
                <lock.icon className="w-3.5 h-3.5" /> {lock.action}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Memoized for the same reason RawFrame is: the trimmer around this panel
// re-renders on every loop-preview tick, and nothing here depends on that.
export default memo(WalkSourceFrames);
