import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { formatTimecode } from '../../utils/formatters.js';

// The cut grid: shots start on a 24 fps frame (the render's default canvas rate).
const FPS = 24;
const STEP = 'flex items-center justify-center rounded bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-[28px]';
const frameOf = (sec) => Math.round(sec * FPS);
const secOf = (frame) => Math.round((frame / FPS) * 1000) / 1000;

/**
 * Where a shot starts, as a frame number: step it a frame at a time or type
 * one. `onMove(sceneId, startSec)` moves the cut, so the shot before this one
 * (`joinsPrevious`) ends on the same frame.
 */
export default function SceneStartFrame({ id, scene, joinsPrevious = false, disabled = false, disabledReason = null, onMove }) {
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(null);
  const frame = pending ?? frameOf(scene.startSec);
  const lastFrame = Math.ceil(scene.endSec * FPS) - 1;
  const locked = disabled || pending != null;
  const move = (next) => {
    setDraft(null);
    if (!Number.isInteger(next) || next === frame || next < 0 || next > lastFrame) return;
    setPending(next);
    Promise.resolve(onMove(scene.sceneId, secOf(next))).finally(() => setPending(null));
  };
  const shown = draft != null && Number.isInteger(Number(draft)) && draft !== '' ? Number(draft) : frame;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" title={disabledReason || undefined}>
      <label htmlFor={id}>Start frame</label>
      <span className="flex items-center gap-1">
        <button type="button" onClick={() => move(frame - 1)} disabled={locked || frame <= 0} className={STEP} aria-label="Start one frame earlier">
          <Minus size={13} />
        </button>
        <input id={id} type="number" inputMode="numeric" min={0} max={lastFrame} step={1} value={draft ?? frame} disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => (e.target.value.trim() === '' ? setDraft(null) : move(Number(e.target.value)))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-20 bg-port-bg border border-port-border rounded px-1 py-1 text-base sm:text-xs tabular-nums min-h-[44px] sm:min-h-0 disabled:opacity-50" />
        <button type="button" onClick={() => move(frame + 1)} disabled={locked || frame >= lastFrame} className={STEP} aria-label="Start one frame later">
          <Plus size={13} />
        </button>
      </span>
      <span className="tabular-nums text-port-text-muted" data-testid="start-frame-time">
        {formatTimecode(secOf(shown))} · {FPS} fps{joinsPrevious ? ' · the shot before ends here' : ''}
      </span>
    </div>
  );
}
