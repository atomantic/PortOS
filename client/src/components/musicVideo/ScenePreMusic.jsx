import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  PRE_MUSIC_DEFAULT_DURATION_SEC, PRE_MUSIC_DURATION_RANGE, PRE_MUSIC_EFFECTS, PRE_MUSIC_LAYER_LIMIT, normalizePreMusic,
} from '../../../../server/lib/musicVideoColdOpen.js';
import { listTracks } from '../../services/api';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';
import { trackOptionLabels } from '../../utils/trackOptionLabels.js';

// Sliders and times move a frame at a time on the render's 24 fps grid.
const STEP_SEC = 1 / 24;
const round3 = (n) => Math.round(n * 1000) / 1000;
const fetchTracks = async () => {
  const data = await listTracks({ silent: true });
  return Array.isArray(data) ? data : data?.tracks || [];
};
const control = 'bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';
const percent = (v) => `${Math.round(v * 100)}%`;

/** A level slider that keeps its own value while dragging and saves once it is let go. */
function LevelSlider({ id, label, value, onCommit, disabled }) {
  const [level, setLevel] = useState(value);
  useEffect(() => { setLevel(value); }, [value]);
  const commit = () => { if (level !== value) onCommit(level); };
  return (
    <span className="flex min-w-[7rem] flex-1 items-center gap-1">
      <label htmlFor={id} className="shrink-0 tabular-nums text-port-text-muted">{label} {percent(level)}</label>
      <input id={id} type="range" min="0" max="2" step="0.05" value={level} disabled={disabled}
        onChange={(e) => setLevel(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        className="min-w-0 flex-1 accent-port-accent min-h-[44px] sm:min-h-0" />
    </span>
  );
}

/** One sound layer: what plays, when it starts in the shot, and how loud. */
function LayerRow({ fieldId, index, layer, spanSec, tracks, onCommit, onRemove, disabled }) {
  const [atSec, setAtSec] = useState(layer.atSec);
  useEffect(() => { setAtSec(layer.atSec); }, [layer.atSec]);
  const commitTime = () => { if (atSec !== layer.atSec) onCommit({ atSec: round3(atSec) }); };
  const id = (name) => fieldId(`pre-music-layer-${index}-${name}`);
  const value = layer.effect ? `effect:${layer.effect}` : `track:${layer.trackId}`;
  const labels = trackOptionLabels(tracks.items);
  const pick = (next) => {
    const [kind, ref] = next.split(/:(.*)/s);
    onCommit(kind === 'effect' ? { effect: ref, trackId: undefined } : { trackId: ref, effect: undefined });
  };
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <label htmlFor={id('sound')} className="sr-only">Sound {index + 1}</label>
      <select id={id('sound')} value={value} disabled={disabled} onChange={(e) => pick(e.target.value)} className={`min-w-0 max-w-[14rem] ${control}`}>
        <optgroup label="Effects">
          {PRE_MUSIC_EFFECTS.map((effect) => <option key={effect.id} value={`effect:${effect.id}`}>{effect.label}</option>)}
        </optgroup>
        <optgroup label="Music library">
          {layer.trackId && !tracks.items.some((t) => t.id === layer.trackId) && <option value={value}>{tracks.state === 'ready' ? 'Missing track' : 'Library track'}</option>}
          {tracks.items.map((t) => <option key={t.id} value={`track:${t.id}`}>{labels.get(t.id)}</option>)}
        </optgroup>
      </select>
      <span className="flex min-w-[8rem] flex-1 items-center gap-1">
        <label htmlFor={id('at')} className="shrink-0 tabular-nums text-port-text-muted">at {atSec.toFixed(2)}s</label>
        <input id={id('at')} type="range" min="0" max={spanSec} step={STEP_SEC} value={Math.min(atSec, spanSec)} disabled={disabled}
          onChange={(e) => setAtSec(Number(e.target.value))} onPointerUp={commitTime} onKeyUp={commitTime} onBlur={commitTime}
          className="min-w-0 flex-1 accent-port-accent min-h-[44px] sm:min-h-0" />
      </span>
      <LevelSlider id={id('volume')} label="level" value={layer.volume} disabled={disabled} onCommit={(volume) => onCommit({ volume })} />
      <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove sound ${index + 1}`}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted hover:text-port-error sm:min-h-[28px] sm:min-w-[28px] disabled:opacity-50">
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * A shot before the song (the cold open, lib/musicVideoColdOpen.js) has a length
 * and sound of its own; the song's timing is untouched either way. The shot editor
 * shows PreMusicTiming in its Timing group and PreMusicSound in its Sound group.
 *
 * PreMusicTiming: whether the shot plays before the song, and its length when it does.
 */
export function PreMusicTiming({ fieldId, scene, onChange, disabled = false }) {
  const settings = normalizePreMusic(scene.preMusic);
  const on = !!settings;
  const [length, setLength] = useState(settings?.durationSec ?? '');
  useEffect(() => { setLength(settings?.durationSec ?? ''); }, [settings?.durationSec]);

  const turnOn = () => {
    // A timed shot keeps its length; otherwise it starts at a few seconds to trim.
    const span = Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec
      ? round3(scene.endSec - scene.startSec) : PRE_MUSIC_DEFAULT_DURATION_SEC;
    onChange({ preMusic: { durationSec: Math.min(PRE_MUSIC_DURATION_RANGE.max, Math.max(PRE_MUSIC_DURATION_RANGE.min, span)) } });
  };
  const commitLength = () => {
    const next = Number(length);
    if (!Number.isFinite(next) || next === settings.durationSec) { setLength(settings.durationSec); return; }
    onChange({ preMusic: { ...settings, durationSec: round3(Math.min(PRE_MUSIC_DURATION_RANGE.max, Math.max(PRE_MUSIC_DURATION_RANGE.min, next))) } });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" role="switch" aria-checked={on} disabled={disabled}
        onClick={() => (on ? onChange({ preMusic: null }) : turnOn())}
        className={`inline-flex min-h-[44px] items-center gap-1 rounded border px-2 sm:min-h-[28px] disabled:opacity-50 ${on ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}>
        Before the song
      </button>
      {on && (
        <label className="flex items-center gap-1">Length
          <input id={fieldId('pre-music-length')} type="number" min={PRE_MUSIC_DURATION_RANGE.min} max={PRE_MUSIC_DURATION_RANGE.max} step={STEP_SEC}
            value={length} disabled={disabled} onChange={(e) => setLength(e.target.value)} onBlur={commitLength}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className={`w-20 ${control}`} />
          <span className="text-port-text-muted">s</span>
        </label>
      )}
    </div>
  );
}

/** A shot before the song's sound: the clip's own audio at a level, and placed sound layers. Nothing while it is in the song. */
export function PreMusicSound({ fieldId, scene, onChange, disabled = false }) {
  const settings = normalizePreMusic(scene.preMusic);
  const on = !!settings;
  const tracks = useListResource(fetchTracks, { enabled: on });
  if (!on) return null;
  const save = (patch) => onChange({ preMusic: { ...settings, ...patch } });
  const layers = settings.layers || [];
  const saveLayers = (next) => save({ layers: next.map(({ effect, trackId, ...rest }) => ({ ...rest, ...(effect ? { effect } : { trackId }) })) });
  // A new sound lands at the start, the place most cold opens begin.
  const addLayer = () => saveLayers([...layers, { effect: PRE_MUSIC_EFFECTS[0].id, atSec: 0, durationSec: null, volume: 1 }]);

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={settings.clipVolume != null && settings.clipVolume > 0} disabled={disabled}
          onClick={() => save({ clipVolume: settings.clipVolume > 0 ? null : 1 })}
          title="Play this clip's own sound. While it is on, a new fal.ai or local render of this shot asks the model for sound (on Kling at its audio-on rate)."
          className={`inline-flex min-h-[44px] items-center rounded border px-2 sm:min-h-[28px] disabled:opacity-50 ${settings.clipVolume > 0 ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}>
          Clip sound
        </button>
        {settings.clipVolume > 0 && (
          <LevelSlider id={fieldId('pre-music-clip-volume')} label="level" value={settings.clipVolume} disabled={disabled}
            onCommit={(clipVolume) => save({ clipVolume: clipVolume > 0 ? clipVolume : null })} />
        )}
        {layers.length < PRE_MUSIC_LAYER_LIMIT && (
          <button type="button" onClick={addLayer} disabled={disabled}
            className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 text-port-text-muted hover:text-port-text sm:min-h-[28px] disabled:opacity-50">
            <Plus size={12} aria-hidden="true" /> Add sound
          </button>
        )}
        {!(settings.clipVolume > 0) && !layers.length && <span className="text-port-text-muted">Silent</span>}
      </div>
      {tracks.state === 'error' && layers.some((layer) => layer.trackId) && <ListLoadError what="the music library" error={tracks.error} onRetry={tracks.retry} />}
      {layers.length > 0 && (
        <ul className="space-y-1">
          {layers.map((layer, index) => (
            <LayerRow key={index} fieldId={fieldId} index={index} layer={layer} spanSec={settings.durationSec} tracks={tracks} disabled={disabled}
              onCommit={(patch) => saveLayers(layers.map((l, i) => (i === index ? { ...l, ...patch } : l)))}
              onRemove={() => saveLayers(layers.filter((_, i) => i !== index))} />
          ))}
        </ul>
      )}
    </div>
  );
}

