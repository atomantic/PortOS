import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { CLIP_OFFSET_FRAMES_RANGE, CLIP_SPEED_FPS_RANGE, CLIP_TIMING_FPS, clipReversed, clipSpeedRate } from '../../lib/musicVideoLayers.js';

const STEP = 'flex items-center justify-center rounded bg-port-bg border border-port-border hover:bg-port-border/40 disabled:opacity-50 min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-[28px]';
const plural = (n) => `${n} frame${n === 1 ? '' : 's'}`;

function Stepper({ id, label, value, range, disabled, onSet, readout, less, more }) {
  const [draft, setDraft] = useState(null);
  const commit = (next) => {
    setDraft(null);
    if (!Number.isInteger(next) || next === value || next < range.min || next > range.max) return;
    onSet(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={id} className="w-12">{label}</label>
      <span className="flex items-center gap-1">
        <button type="button" onClick={() => commit(value - 1)} disabled={disabled || value <= range.min} className={STEP} aria-label={less}>
          <Minus size={13} />
        </button>
        <input id={id} type="number" inputMode="numeric" min={range.min} max={range.max} step={1} value={draft ?? value} disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => (e.target.value.trim() === '' ? setDraft(null) : commit(Number(e.target.value)))}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className="w-16 bg-port-bg border border-port-border rounded px-1 py-1 text-base sm:text-xs tabular-nums min-h-[44px] sm:min-h-0 disabled:opacity-50" />
        <button type="button" onClick={() => commit(value + 1)} disabled={disabled || value >= range.max} className={STEP} aria-label={more}>
          <Plus size={13} />
        </button>
      </span>
      <span className="tabular-nums text-port-text-muted">{readout}</span>
    </div>
  );
}

/**
 * A footage shot's clip timing, set by hand and played the same way by the
 * player and the final render, from the one clip file: Speed in frames per
 * second over the 24 fps grid, Offset in frames against the song, and Reverse.
 * `onChange(patch)` saves `{ speedFps }`, `{ offsetFrames }` (0 clears it) or `{ reverse }`.
 */
export default function SceneClipTiming({ fieldId, scene, disabled = false, disabledReason = null, onChange }) {
  const speed = Number.isInteger(scene.speedFps) ? scene.speedFps : 0;
  const offset = Number.isInteger(scene.offsetFrames) ? scene.offsetFrames : 0;
  const rate = clipSpeedRate(scene);
  const offsetText = offset > 0 ? `starts ${plural(offset)} into the clip`
    : offset < 0 ? `clip starts ${plural(-offset)} later` : 'on the cut';
  return (
    <div className="space-y-1" title={disabledReason || undefined}>
      <Stepper id={fieldId('speed')} label="Speed" value={speed} range={CLIP_SPEED_FPS_RANGE} disabled={disabled}
        less="Play the clip one fps slower" more="Play the clip one fps faster"
        onSet={(next) => onChange({ speedFps: next || null })}
        readout={`${CLIP_TIMING_FPS + speed} fps (${Number(rate.toFixed(2))}×)`} />
      <Stepper id={fieldId('offset')} label="Offset" value={offset} range={CLIP_OFFSET_FRAMES_RANGE} disabled={disabled}
        less="Start the clip one frame later" more="Start the clip one frame further in"
        onSet={(next) => onChange({ offsetFrames: next || null })}
        readout={offsetText} />
      {/* A lip-sync performance never reverses: its mouth follows the song. */}
      {scene.shotMode !== 'performance' && (
        <label htmlFor={fieldId('reverse')} className="flex min-h-[44px] items-center gap-2 text-xs sm:min-h-0">
          <input id={fieldId('reverse')} type="checkbox" checked={clipReversed(scene)} disabled={disabled}
            onChange={(e) => onChange({ reverse: e.target.checked || null })} />
          Reverse <span className="text-port-text-muted">plays backwards, no loop</span>
        </label>
      )}
    </div>
  );
}
