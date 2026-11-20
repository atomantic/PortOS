import { useEffect, useRef, useState } from 'react';
import { AudioLines, Crosshair, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { formatTimecode } from '../../utils/formatters.js';

// A dragged layer is pulled onto a beat, lyric line or the song's start within this many pixels.
const SNAP_PX = 6;
// A press on a layer becomes a drag after moving this far; short of it, it is a tap.
const DRAG_PX = 3;
// The narrowest a layer draws, so a short one can still be seen and grabbed.
const LAYER_MIN_PX = 10;
// A layer at least this wide shows its name.
const LABEL_MIN_PX = 40;
// The loudest a layer may be set (the server's MUSIC_VIDEO_AUDIO_LAYER_MAX_VOLUME): 200%, +6 dB.
export const AUDIO_LAYER_MAX_VOLUME = 2;
export const AUDIO_LAYER_ROW_H = 'h-8 pointer-coarse:h-12';
// Formats the upload route takes (isSupportedMusicUpload on the server).
export const AUDIO_LAYER_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.ogg,.flac';

const roundMs = (t) => Math.round(t * 1000) / 1000;
const layerSpanSec = (layer) => (layer.durationSec > 0 ? layer.durationSec : 1);

/** `t` pulled onto the nearest snap point within `tolerance` seconds, or left as is. */
export function snapLayerStart(t, snapPoints, tolerance) {
  let best = null;
  for (const point of [0, ...(snapPoints || [])]) {
    const gap = Math.abs(point - t);
    if (gap <= tolerance && (best == null || gap < Math.abs(best - t))) best = point;
  }
  return best == null ? { t: roundMs(Math.max(0, t)), snapped: false } : { t: roundMs(best), snapped: true };
}

/**
 * One audio layer's row: its file as a block on the song's clock, dragged
 * along the row to move it (pulled onto a nearby beat or lyric line), nudged a
 * frame with the arrow keys (Shift: a second), and tapped to open its controls
 * (`onSelect(id, toggle)`: a tap toggles them, a drag keeps them open).
 * `onMove(id, startSec)` saves a move; without it the block only selects.
 */
export function TimelineAudioLayerRow({ layer, pxPerSec, durationSec, snapPoints, selected, onSelect, onMove }) {
  const [drag, setDrag] = useState(null);
  const pointer = useRef(null);
  const startSec = drag ? drag.t : layer.startSec;
  const width = Math.max(LAYER_MIN_PX, layerSpanSec(layer) * pxPerSec);
  const maxStart = Math.max(0, durationSec - 0.05);
  // A saved move arrives as the layer's new start; the dragged position holds until then.
  useEffect(() => { setDrag((current) => (current?.saving ? null : current)); }, [layer.startSec]);
  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointer.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
  };
  const onPointerMove = (event) => {
    const p = pointer.current;
    if (!p || p.pointerId !== event.pointerId || !onMove) return;
    const dx = event.clientX - p.startX;
    if (!p.moved && Math.abs(dx) < DRAG_PX) return;
    p.moved = true;
    const next = snapLayerStart(Math.min(maxStart, layer.startSec + dx / pxPerSec), snapPoints, SNAP_PX / pxPerSec);
    setDrag(next);
  };
  const onPointerUp = (event, cancelled = false) => {
    const p = pointer.current;
    if (!p || p.pointerId !== event.pointerId) return;
    pointer.current = null;
    if (!p.moved) { if (!cancelled) onSelect(layer.id); return; }
    if (cancelled || !drag || Math.abs(drag.t - layer.startSec) < 1e-4) { setDrag(null); return; }
    setDrag({ ...drag, saving: true });
    onSelect(layer.id, false);
    Promise.resolve(onMove(layer.id, drag.t)).catch(() => {}).finally(() => setDrag((current) => (current?.saving ? null : current)));
  };
  const onKeyDown = (event) => {
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(layer.id); return; }
    if (!dir || !onMove) return;
    event.preventDefault();
    onMove(layer.id, roundMs(Math.min(maxStart, Math.max(0, layer.startSec + dir * (event.shiftKey ? 1 : 1 / 24)))));
  };
  const name = layer.label || 'Audio';
  return (
    <div role="slider" tabIndex={0} aria-orientation="horizontal" data-layer-id={layer.id}
      aria-label={`Audio layer ${name}${layer.muted ? ' (muted)' : ''}`}
      aria-valuemin={0} aria-valuemax={roundMs(maxStart)} aria-valuenow={roundMs(startSec)} aria-valuetext={formatTimecode(startSec)}
      title={`${name} · starts ${formatTimecode(startSec)} · ${layerSpanSec(layer).toFixed(2)}s${onMove ? ' · drag to move' : ''}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={(event) => onPointerUp(event, true)} onKeyDown={onKeyDown}
      className={`absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded-sm border px-1 text-[10px] leading-4 touch-none select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${onMove ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${drag?.snapped ? 'border-port-success' : selected ? 'z-10 border-port-accent ring-2 ring-port-accent' : 'border-port-accent/60'} ${layer.muted ? 'bg-port-border/40 text-port-text-muted opacity-60' : 'bg-port-accent/20 text-port-text'}`}
      style={{ left: startSec * pxPerSec, width }}>
      {width >= LABEL_MIN_PX && (
        <>
          {layer.muted ? <VolumeX size={11} className="shrink-0" aria-hidden="true" /> : <AudioLines size={11} className="shrink-0" aria-hidden="true" />}
          <span className="truncate">{name}</span>
        </>
      )}
    </div>
  );
}

const fieldCls = 'min-h-[44px] rounded border border-port-border bg-port-bg px-1.5 text-xs text-port-text disabled:opacity-50 pointer-fine:sm:min-h-[28px]';
const buttonCls = 'flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-xs text-port-text hover:border-port-accent disabled:opacity-40 pointer-fine:sm:min-h-[28px]';

/**
 * The selected audio layer's controls: its name, where it starts, its level
 * (0–200% of the file), mute, move it to the playhead, and remove it. Each
 * change saves through `onChange(patch)`; a slider saves once let go.
 */
export function TimelineAudioLayerPanel({ layer, playheadSec, onChange, onRemove, onClose }) {
  const [volume, setVolume] = useState(layer.volume);
  const [label, setLabel] = useState(layer.label);
  const [start, setStart] = useState(String(layer.startSec));
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setVolume(layer.volume); }, [layer.volume]);
  useEffect(() => { setLabel(layer.label); }, [layer.label]);
  useEffect(() => { setStart(String(layer.startSec)); }, [layer.startSec]);
  const id = `mv-audio-layer-${layer.id}`;
  const commitVolume = () => { if (volume !== layer.volume) onChange({ volume }); };
  const commitLabel = () => {
    const next = label.trim();
    if (next && next !== layer.label) onChange({ label: next });
    else setLabel(layer.label);
  };
  const commitStart = () => {
    const next = Number(start);
    if (Number.isFinite(next) && next >= 0 && Math.abs(next - layer.startSec) > 1e-4) onChange({ startSec: roundMs(next) });
    else setStart(String(layer.startSec));
  };
  return (
    <section aria-label={`Audio layer ${layer.label}`} className="flex min-w-0 flex-wrap items-end gap-2 border-t border-port-border px-2 py-2 text-xs">
      <div className="min-w-0">
        <label htmlFor={`${id}-label`} className="block text-[10px] text-port-text-muted">Audio layer</label>
        <input id={`${id}-label`} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} className={`${fieldCls} w-44 max-w-full`} />
      </div>
      <div>
        <label htmlFor={`${id}-start`} className="block text-[10px] text-port-text-muted">Starts at (seconds)</label>
        <input id={`${id}-start`} type="number" min={0} step={0.01} inputMode="decimal" value={start}
          onChange={(e) => setStart(e.target.value)} onBlur={commitStart}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} className={`${fieldCls} w-24 tabular-nums`} />
      </div>
      <div>
        <label htmlFor={`${id}-volume`} className="block text-[10px] text-port-text-muted">Level ({Math.round(volume * 100)}%)</label>
        <input id={`${id}-volume`} type="range" min={0} max={AUDIO_LAYER_MAX_VOLUME} step={0.05} value={volume}
          onChange={(e) => setVolume(Number(e.target.value))} onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume}
          className="w-32" />
      </div>
      <button type="button" className={buttonCls} aria-pressed={layer.muted} onClick={() => onChange({ muted: !layer.muted })}>
        {layer.muted ? <VolumeX size={13} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
        {layer.muted ? 'Unmute' : 'Mute'}
      </button>
      <button type="button" className={buttonCls} onClick={() => onChange({ startSec: roundMs(playheadSec()) })}
        title="Start this layer where the playhead is">
        <Crosshair size={13} aria-hidden="true" /> Move to playhead
      </button>
      {confirmRemove ? (
        <span className="flex items-center gap-1">
          <button type="button" className={`${buttonCls} border-port-error text-port-error`} onClick={onRemove}>
            <Trash2 size={13} aria-hidden="true" /> Remove layer
          </button>
          <button type="button" className={buttonCls} onClick={() => setConfirmRemove(false)}>Keep</button>
        </span>
      ) : (
        <button type="button" className={buttonCls} onClick={() => setConfirmRemove(true)}>
          <Trash2 size={13} aria-hidden="true" /> Remove
        </button>
      )}
      <button type="button" onClick={onClose} aria-label="Close audio layer controls" title="Close"
        className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text hover:border-port-accent pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]">
        <X size={14} aria-hidden="true" />
      </button>
    </section>
  );
}
