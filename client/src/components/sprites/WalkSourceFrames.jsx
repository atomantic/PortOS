import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Film, ChevronDown, ChevronRight, Gauge, RefreshCw, RotateCcw, Unlock,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  getSpriteWalkSourceFrames, postprocessSpriteWalk, setSpriteWalkTarget,
  unlockSpriteWalk, reopenSpriteWalk,
} from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { spriteAssetUrl, PIXELATED } from './spriteAssets.js';
import {
  WALK_FRAME_COUNT_OPTIONS, walkFpsOptionsFor,
} from '../../lib/spriteTrimmer.js';

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
// The re-derive's frame count / fps are the SET-level cycle target (#2985), not
// a free per-run range: every direction of one walk occupies the same atlas
// columns, so re-deriving one direction to a value the rest of the set doesn't
// share just recreates a ragged set from the other end (and the server would
// 409 WALK_TARGET_MISMATCH anyway). Changing them here retargets the whole set,
// which is stated inline.

// Why a run has no frames to show. Both are real states on this install, and
// neither is an error — the panel explains rather than rendering an empty grid.
const UNAVAILABLE_COPY = {
  'no-source-video': 'This run was imported without its source clip, so the packed strip is all that exists here — frames can be dropped but not added. Re-import this character to bring its clip across.',
  'run-not-packaged': 'This direction came from a redraw cycle rather than a rendered clip, so there are no source frames behind it.',
};

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
function RawFrame({ recordId, frame, inWindow, packed }) {
  const marks = [
    inWindow ? 'in the selected cycle window' : null,
    packed ? 'packed into the strip' : null,
  ].filter(Boolean);
  return (
    <div
      className={`rounded overflow-hidden border ${
        packed ? 'border-port-accent ring-1 ring-port-accent'
          : inWindow ? 'border-port-warning/70' : 'border-port-border'
      } ${inWindow || packed ? '' : 'opacity-60'}`}
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
}

export default function WalkSourceFrames({ recordId, runId, onSaved = () => {} }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The re-derive geometry. Seeded from the resolved SET target on every load so
  // the control can never show a value the set isn't actually on.
  const [frameCount, setFrameCount] = useState(null);
  const [fps, setFps] = useState(null);
  // The target PUT is a separate request from the reprocess; while it is in
  // flight the reprocess would be gated against a value the server has not
  // persisted yet, so it holds its own flag rather than riding on the action's.
  const [targetSaving, setTargetSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // The component owns its own error UI (the line below), so the request is
    // silent — otherwise the helper toasts and this renders the same failure.
    const next = await getSpriteWalkSourceFrames(recordId, runId, { silent: true })
      .catch((err) => { setLoadError(err?.message || 'Could not read this run\'s source frames'); return null; });
    setLoading(false);
    if (!next) return;
    setData(next);
    setFrameCount(next.target?.frameCount ?? next.current?.frameCount ?? null);
    setFps(next.target?.fps ?? next.current?.fps ?? null);
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

  const target = data?.target || null;
  const retargets = Boolean(target) && (frameCount !== target.frameCount || fps !== target.fps);

  const [redrive, redriving] = useAsyncAction(async () => {
    // A geometry the set isn't on must be pinned at the SET level first — the
    // reprocess is refused (409 WALK_TARGET_MISMATCH) against a target it
    // disagrees with, by design.
    if (retargets) {
      setTargetSaving(true);
      try {
        await setSpriteWalkTarget(recordId, { frameCount, fps }, { silent: true });
      } finally {
        setTargetSaving(false);
      }
    }
    await postprocessSpriteWalk(recordId, { runId, frameCount, fps }, { silent: true });
    toast.success(`Re-derived from the source clip · ${frameCount}f @ ${fps}fps`);
    onSaved();
    await load();
  }, { errorMessage: 'Could not re-derive this loop' });

  const [unlock, unlocking] = useAsyncAction(async () => {
    if (data.lockReason === 'finalized') {
      await unlockSpriteWalk(recordId, { silent: true });
      toast.success('Walk set unlocked — every direction is editable again');
    } else {
      await reopenSpriteWalk(recordId, { direction: data.direction }, { silent: true });
      toast.success(`${data.direction} reopened`);
    }
    onSaved();
    await load();
  }, { errorMessage: 'Could not unlock this direction' });

  const busy = loading || redriving || unlocking || targetSaving;
  const lock = data && !data.editable ? LOCK_COPY[data.lockReason] : null;
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
        <p className="text-[11px] text-gray-500 leading-relaxed">
          {UNAVAILABLE_COPY[data.reason] || 'No source frames are available for this run.'}
        </p>
      )}

      {data.available && open && (
        <>
          <p className="text-[11px] text-gray-500">
            Extracted from this run&apos;s clip at {data.extractionFps}fps
            {data.maxSourceSeconds ? ` (first ${data.maxSourceSeconds}s)` : ''}.
            {data.cycle?.windowStartFrame != null && (
              <>
                {' '}Frames {data.cycle.windowStartFrame}–{data.cycle.windowEndFrame} are the gait
                cycle the packer selected (
                <span className="text-port-warning">amber</span>); the{' '}
                <span className="text-port-accent">highlighted</span> ones became the packed
                strip&apos;s columns.
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
          grid above is context, not a precondition. */}
      <div className="border-t border-port-border pt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor="trimmer-derive-frames">
            Re-derive at
            <select
              id="trimmer-derive-frames"
              value={frameCount ?? ''}
              disabled={busy || !data.editable || Boolean(target?.frameCountLocked)}
              onChange={(e) => setFrameCount(Number(e.target.value))}
              title="Frames in the walk cycle — shared by all 8 directions, because the atlas is a rectangular grid"
              className="bg-port-card border border-port-border rounded px-2 py-1 text-sm text-white disabled:opacity-60"
            >
              {WALK_FRAME_COUNT_OPTIONS.map((n) => <option key={n} value={n}>{n} frames</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor="trimmer-derive-fps">
            <span className="flex items-center gap-1"><Gauge className="w-3 h-3" /> Preview speed</span>
            <select
              id="trimmer-derive-fps"
              value={fps ?? ''}
              disabled={busy || !data.editable || Boolean(target?.fpsLocked)}
              onChange={(e) => setFps(Number(e.target.value))}
              title="Preview/authoring speed — the consuming app decides real in-game playback"
              className="bg-port-card border border-port-border rounded px-2 py-1 text-sm text-white disabled:opacity-60"
            >
              {walkFpsOptionsFor(fps).map((n) => <option key={n} value={n}>{n} fps</option>)}
            </select>
          </label>
          <button
            onClick={redrive}
            disabled={busy || !data.editable || !frameCount || !fps}
            title={data.editable
              ? 'Rebuild this loop from the clip already on disk — no new render'
              : 'This run is locked — see below'}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-xs"
          >
            {redriving || targetSaving
              ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Re-deriving…</>
              : <><RefreshCw className="w-3.5 h-3.5" /> Re-derive from clip</>}
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          {retargets
            ? `Changing the cycle re-targets the whole set to ${frameCount}f @ ${fps}fps — the other directions will need re-deriving too.`
            : `The set targets ${target?.frameCount}f @ ${target?.fps}fps (${target?.sourceLabel || target?.source || 'default'}). Re-deriving repacks this run from its clip — no AI call, no new render.`}
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
