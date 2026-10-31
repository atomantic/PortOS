import { useState } from 'react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import { PHOTO_SEQUENCE_DEFAULT_FRAMES, PHOTO_SEQUENCE_LIMIT } from '../../lib/musicVideoImageEffects.js';
import { BEAT_TOGGLE_RATES, BEAT_TOGGLE_RATE_LABELS } from '../../lib/musicVideoCutEffects.js';
import { formatCount } from '../../utils/formatters.js';

const CONTROL = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';

export default function ScenePhotoSequence({ scene, fieldId, onChange, disabled = false, beats = [], fps = 24 }) {
  const [picking, setPicking] = useState(false);
  const [unit, setUnit] = useState('frames');
  const [missing, setMissing] = useState({});
  const sequence = scene.photoSequence || { enabled: false, imageIds: [], intervalFrames: PHOTO_SEQUENCE_DEFAULT_FRAMES, rate: 'frames' };
  const enabled = !!scene.photoSequence && sequence.enabled !== false;
  const save = patch => onChange({ photoSequence: { ...sequence, ...patch } });
  const reorder = (index, direction) => {
    const ids = [...sequence.imageIds];
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    save({ imageIds: ids });
  };
  const frames = sequence.intervalFrames;
  const rate = sequence.rate || 'frames';
  return (
    <div className="space-y-2" data-testid="scene-photo-sequence">
      <label htmlFor={fieldId('photo-sequence')} className="flex min-h-[44px] items-center gap-2 text-xs">
        <input id={fieldId('photo-sequence')} type="checkbox" disabled={disabled} checked={enabled}
          onChange={e => save({ enabled: e.target.checked,
            imageIds: !scene.photoSequence && scene.referenceImageId ? [scene.referenceImageId] : sequence.imageIds })} />
        Photo sequence
      </label>
      {enabled && <>
        <ol className="flex flex-wrap gap-2">
          {sequence.imageIds.map((id, i) => <li key={`${i}:${id}`} className="w-28 min-w-0 space-y-1 rounded border border-port-border p-1">
            <img src={`/data/images/${encodeURIComponent(id)}`} alt={`Photo ${i + 1}`} className="aspect-video w-full object-cover"
              onError={() => setMissing(prev => ({ ...prev, [id]: true }))} onLoad={() => setMissing(prev => prev[id] ? { ...prev, [id]: false } : prev)} />
            <span className="block truncate text-[11px]" title={id}>{formatCount(i + 1)} · {id}</span>
            {missing[id] && <span role="alert" className="text-xs text-port-error">Missing photo</span>}
            <div className="flex gap-1">
              <button type="button" className={CONTROL} aria-label={`Move photo ${i + 1} earlier`} disabled={disabled || i === 0} onClick={() => reorder(i, -1)}>←</button>
              <button type="button" className={CONTROL} aria-label={`Move photo ${i + 1} later`} disabled={disabled || i === sequence.imageIds.length - 1} onClick={() => reorder(i, 1)}>→</button>
              <button type="button" className={CONTROL} aria-label={`Remove photo ${i + 1}`} disabled={disabled}
                onClick={() => save({ imageIds: sequence.imageIds.filter((_, index) => index !== i) })}>×</button>
            </div>
          </li>)}
        </ol>
        <button type="button" className={CONTROL} disabled={disabled || sequence.imageIds.length >= PHOTO_SEQUENCE_LIMIT} onClick={() => setPicking(true)}>Add existing photo</button>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={fieldId('photo-rate')}>Cadence</label>
          <select id={fieldId('photo-rate')} value={rate} disabled={disabled} className={CONTROL} onChange={e => save({ rate: e.target.value })}>
            <option value="frames">Fixed interval</option>
            {BEAT_TOGGLE_RATES.map(value => <option key={value} value={value} disabled={!beats.length}>{BEAT_TOGGLE_RATE_LABELS[value]}</option>)}
          </select>
          {rate === 'frames' && <>
            <label className="sr-only" htmlFor={fieldId('photo-interval')}>Photo interval</label>
            <input id={fieldId('photo-interval')} type="number" min={unit === 'frames' ? 1 : 1 / fps} max={unit === 'frames' ? 720 : 720 / fps}
              step={unit === 'frames' ? 1 : 1 / fps} className={`w-24 ${CONTROL}`} disabled={disabled}
              value={unit === 'frames' ? frames : Number((frames / fps).toFixed(4))}
              onChange={e => { const value = Number(e.target.value); const next = Math.round(value * (unit === 'frames' ? 1 : fps)); if (next >= 1 && next <= 720) save({ intervalFrames: next }); }} />
            <label className="sr-only" htmlFor={fieldId('photo-unit')}>Photo interval unit</label>
            <select id={fieldId('photo-unit')} value={unit} disabled={disabled} className={CONTROL} onChange={e => setUnit(e.target.value)}>
              <option value="frames">Frames</option><option value="seconds">Seconds</option>
            </select>
          </>}
        </div>
        <p className="text-[11px] text-port-text-muted">
          {rate === 'frames' || !beats.length ? `${formatCount(frames)} frames / ${(frames / fps).toFixed(3)}s per photo at ${formatCount(fps)} fps. ` : `${BEAT_TOGGLE_RATE_LABELS[rate]} on the song grid. `}
          Repeats in order within this shot; audio and shot length stay the same.
        </p>
        {!sequence.imageIds.length && <p role="alert" className="text-xs text-port-warning">Add photos before previewing or rendering.</p>}
      </>}
      {picking && <GalleryImagePicker open onClose={() => setPicking(false)} onSelect={item => save({ imageIds: [...sequence.imageIds, item.filename] })} />}
    </div>
  );
}
