import { useState } from 'react';
import { Merge, Minus, Plus, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { CLIP_TIMING_FPS } from '../../lib/musicVideoLayers.js';

const BUTTON = 'inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 px-2 py-1 text-xs min-h-[44px] sm:min-h-0';
const STEP = 'flex items-center justify-center rounded bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-[28px]';
// The shortest piece the server leaves on either side of a split or a moved cut (projectsLogic MIN_SPLIT_PIECE_SEC).
const MIN_PIECE_SEC = 0.1;
const tenth = (sec) => Math.round(sec * 10) / 10;
const hundredth = (sec) => Math.round(sec * 100) / 100;
const frameOf = (sec) => Math.round(sec * CLIP_TIMING_FPS);
const secOf = (frame) => Math.round((frame / CLIP_TIMING_FPS) * 1000) / 1000;

/** Cut a shot in two at a time the director picks on a slider (default: its middle). */
function SplitAt({ sceneId, startSec, endSec, onSplit }) {
  const [open, setOpen] = useState(false);
  const min = Math.ceil((startSec + MIN_PIECE_SEC) * 10) / 10;
  const max = Math.floor((endSec - MIN_PIECE_SEC) * 10) / 10;
  const [atSec, setAtSec] = useState(() => tenth((startSec + endSec) / 2));
  const splitSec = Math.min(max, Math.max(min, atSec));
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={BUTTON} title="Cut this shot in two at a time you pick">
        <Scissors size={13} /> Split shot
      </button>
    );
  }
  const inputId = `mv-scene-${sceneId}-split-at`;
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs">
      <label htmlFor={inputId} className="shrink-0">Split at</label>
      <input id={inputId} type="range" min={min} max={max} step={0.1} value={splitSec}
        onChange={(e) => setAtSec(Number(e.target.value))} className="min-w-0 flex-1 basis-32" />
      <span className="shrink-0 tabular-nums text-port-text-muted">{(splitSec - startSec).toFixed(1)}s in · {formatDurationSec(splitSec)}</span>
      <button type="button" onClick={() => { onSplit(sceneId, null, splitSec); setOpen(false); }} className={BUTTON}>
        <Scissors size={13} /> Split here
      </button>
      <button type="button" onClick={() => setOpen(false)} className={BUTTON}>Cancel</button>
    </div>
  );
}

/**
 * How long a shot runs: type seconds or step a frame at a time. `onMoveEnd(sceneId, endSec)`
 * moves the cut after it, so the next shot (when `nextEndSec` is known) grows or shrinks to meet the new end.
 */
export function SceneDuration({ id, scene, nextEndSec = null, songDurationSec = null, onMoveEnd }) {
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(null);
  const endSec = pending ?? scene.endSec;
  const durationSec = hundredth(endSec - scene.startSec);
  const maxEnd = nextEndSec != null ? nextEndSec - MIN_PIECE_SEC : songDurationSec;
  const locked = pending != null;
  const moveTo = (next) => {
    setDraft(null);
    if (!(next > 0) || Math.abs(next - scene.endSec) < 0.001) return;
    setPending(next);
    Promise.resolve(onMoveEnd(scene.sceneId, next)).finally(() => setPending(null));
  };
  const stepFrames = (by) => moveTo(secOf(frameOf(endSec) + by));
  const frames = frameOf(endSec) - frameOf(scene.startSec);
  const atMin = secOf(frameOf(endSec) - 1) < scene.startSec + MIN_PIECE_SEC;
  const atMax = maxEnd != null && secOf(frameOf(endSec) + 1) > maxEnd;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={id}>Duration</label>
      <span className="flex items-center gap-1">
        <button type="button" onClick={() => stepFrames(-1)} disabled={locked || atMin} className={STEP} aria-label="One frame shorter"><Minus size={13} /></button>
        <input id={id} type="number" inputMode="decimal" min={MIN_PIECE_SEC} step={0.01} value={draft ?? durationSec} disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            const typed = e.target.value.trim();
            if (typed === '' || !Number.isFinite(Number(typed))) { setDraft(null); return; }
            moveTo(hundredth(scene.startSec + Number(typed)));
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 text-base sm:text-xs tabular-nums min-h-[44px] sm:min-h-0 disabled:opacity-50" />
        <button type="button" onClick={() => stepFrames(1)} disabled={locked || atMax} className={STEP} aria-label="One frame longer"><Plus size={13} /></button>
      </span>
      <span className="tabular-nums text-port-text-muted" data-testid="shot-duration-note">
        s · {frames} fr · ends {formatDurationSec(endSec)}{nextEndSec != null ? ' · the next shot starts here' : ''}
      </span>
    </div>
  );
}

/** A shot's start or end, typed: the cut moves when the field is left, so the shot beside it follows. */
export function SceneCutField({ label, value, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = (typed) => {
    const next = Number(typed);
    if (typed.trim() === '' || !Number.isFinite(next) || next < 0 || Math.abs(next - value) < 0.001) { setDraft(null); return; }
    // The draft stays until the move answers, then the shot's real time shows, whether or not it was refused.
    Promise.resolve(onCommit(next)).finally(() => setDraft(null));
  };
  return (
    <label className="flex items-center gap-1">{label}
      <input type="number" min="0" step="0.01" value={draft ?? value} className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <span className="tabular-nums text-port-text-muted">fr {frameOf(draft != null && draft !== '' ? Number(draft) : value)}</span>
    </label>
  );
}

/** Split and merge a shot, available on every kind of timed shot. `span` (its start and end) offers a split at a picked time. */
export default function SceneShotCuts({ timing, sceneId, lipSyncBackend, onSplit, onMergeNext, onMergePrevious = null, span = null }) {
  const { timedSpan, canSplit, splitLimit, canMerge, canMergePrevious, mergeBlocked, mergePreviousBlocked } = timing;
  const backend = lipSyncBackend || null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="shot-cut-controls">
      {canSplit && onSplit && (
        <button type="button" onClick={() => onSplit(sceneId, backend)} className={BUTTON}
          title={`Cut this ${timedSpan.toFixed(1)}s shot into scenes of at most ${splitLimit.toFixed(2)}s at lyric pauses or phrase boundaries — nothing is looped or stretched`}>
          <Scissors size={13} /> Split on lyric boundaries
        </button>
      )}
      {onSplit && span && span.endSec - span.startSec >= 2 * MIN_PIECE_SEC + 0.1 && (
        <SplitAt key={`${span.startSec}-${span.endSec}`} sceneId={sceneId} startSec={span.startSec} endSec={span.endSec} onSplit={onSplit} />
      )}
      {(canMergePrevious || mergePreviousBlocked) && onMergePrevious && (
        <button type="button" onClick={() => onMergePrevious(sceneId, backend)} disabled={!canMergePrevious} className={BUTTON}
          title={mergePreviousBlocked || 'Remove the previous shot and start this one where it started'}>
          <Merge size={13} /> Merge over previous
        </button>
      )}
      {(canMerge || mergeBlocked) && (
        <button type="button" onClick={() => onMergeNext(sceneId, backend)} disabled={!canMerge} className={BUTTON}
          title={mergeBlocked || 'Keep this shot and extend it over the next one, which is removed — the inverse of split'}>
          <Merge size={13} /> Merge with next
        </button>
      )}
    </div>
  );
}
