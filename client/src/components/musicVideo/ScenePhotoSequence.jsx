import { useState } from 'react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import {
  DEFAULT_PHOTO_LAYOUT, PHOTO_LAYOUT_RANGES, PHOTO_SEQUENCE_DEFAULT_FRAMES, PHOTO_SEQUENCE_LIMIT, PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES, photoStackLayouts,
} from '../../lib/musicVideoImageEffects.js';
import { BEAT_TOGGLE_RATES, BEAT_TOGGLE_RATE_LABELS } from '../../lib/musicVideoCutEffects.js';
import { formatCount } from '../../utils/formatters.js';

const CONTROL = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';

// #14277: the per-photo layout fields, in the units the editor shows them.
const LAYOUT_FIELDS = [
  { key: 'x', label: 'Across', unit: '%', factor: 100, step: 1 },
  { key: 'y', label: 'Down', unit: '%', factor: 100, step: 1 },
  { key: 'scale', label: 'Size', unit: '%', factor: 100, step: 1 },
  { key: 'rotation', label: 'Turn', unit: '°', factor: 1, step: 0.5 },
  { key: 'opacity', label: 'Opacity', unit: '%', factor: 100, step: 1 },
];

// Layouts run parallel to the photos: absent entries are full frame.
const layoutsFor = (sequence) => sequence.imageIds.map((_, i) => sequence.layouts?.[i] || null);
const hasLayouts = (sequence) => layoutsFor(sequence).some(Boolean);

export default function ScenePhotoSequence({ scene, fieldId, onChange, disabled = false, beats = [], fps = 24 }) {
  const [picking, setPicking] = useState(false);
  const [unit, setUnit] = useState('frames');
  const [missing, setMissing] = useState({});
  const [editing, setEditing] = useState(null);
  const sequence = scene.photoSequence || { enabled: false, imageIds: [], intervalFrames: PHOTO_SEQUENCE_DEFAULT_FRAMES, rate: 'frames' };
  const enabled = !!scene.photoSequence && sequence.enabled !== false;
  const save = patch => onChange({ photoSequence: { ...sequence, ...patch } });
  // Photos and their layouts move together, so a layout never lands on another photo.
  const saveEntries = (entries) => save({
    imageIds: entries.map(entry => entry.id),
    ...(sequence.layouts ? { layouts: entries.map(entry => entry.layout) } : {}),
  });
  const entries = sequence.imageIds.map((id, i) => ({ id, layout: layoutsFor(sequence)[i] }));
  const reorder = (index, direction) => {
    const next = [...entries];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    saveEntries(next);
    if (editing === index) setEditing(index + direction);
  };
  const remove = (index) => {
    saveEntries(entries.filter((_, i) => i !== index));
    if (editing === index) setEditing(null);
  };
  const add = (filename) => saveEntries([...entries, {
    id: filename,
    // A photo added to a laid-out stack joins the pile instead of covering it.
    layout: hasLayouts(sequence) ? photoStackLayouts(entries.length + 1)[entries.length] : null,
  }]);
  const frames = sequence.intervalFrames;
  const overlap = sequence.overlapFrames || 0;
  const rate = sequence.rate || 'frames';
  const perUnit = unit === 'frames' ? 1 : fps;
  const shown = value => unit === 'frames' ? value : Number((value / fps).toFixed(4));
  const setLayout = (index, layout) => save({ layouts: layoutsFor(sequence).map((current, i) => i === index ? layout : current) });
  const editingLayout = editing != null ? entries[editing]?.layout : null;
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
          {entries.map(({ id, layout }, i) => <li key={`${i}:${id}`} className={`w-28 min-w-0 space-y-1 rounded border p-1 ${editing === i ? 'border-port-accent' : 'border-port-border'}`}>
            <img src={`/data/images/${encodeURIComponent(id)}`} alt={`Photo ${i + 1}`} className="aspect-video w-full object-cover"
              onError={() => setMissing(prev => ({ ...prev, [id]: true }))} onLoad={() => setMissing(prev => prev[id] ? { ...prev, [id]: false } : prev)} />
            <span className="block truncate text-[11px]" title={id}>{formatCount(i + 1)} · {id}</span>
            {missing[id] && <span role="alert" className="text-xs text-port-error">Missing photo</span>}
            <div className="flex flex-wrap gap-1">
              <button type="button" className={CONTROL} aria-label={`Move photo ${i + 1} earlier`} disabled={disabled || i === 0} onClick={() => reorder(i, -1)}>←</button>
              <button type="button" className={CONTROL} aria-label={`Move photo ${i + 1} later`} disabled={disabled || i === entries.length - 1} onClick={() => reorder(i, 1)}>→</button>
              <button type="button" className={CONTROL} aria-label={`Remove photo ${i + 1}`} disabled={disabled} onClick={() => remove(i)}>×</button>
              <button type="button" className={CONTROL} aria-label={`Edit layout of photo ${i + 1}`} aria-pressed={editing === i} disabled={disabled}
                onClick={() => setEditing(editing === i ? null : i)}>{layout ? 'Layout' : 'Full'}</button>
            </div>
          </li>)}
        </ol>
        <button type="button" className={CONTROL} disabled={disabled || entries.length >= PHOTO_SEQUENCE_LIMIT} onClick={() => setPicking(true)}>Add existing photo</button>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={fieldId('photo-rate')}>Cadence</label>
          <select id={fieldId('photo-rate')} value={rate} disabled={disabled} className={CONTROL} onChange={e => save({ rate: e.target.value })}>
            <option value="frames">Fixed interval</option>
            {BEAT_TOGGLE_RATES.map(value => <option key={value} value={value} disabled={!beats.length}>{BEAT_TOGGLE_RATE_LABELS[value]}</option>)}
          </select>
          {rate === 'frames' && <>
            <label className="sr-only" htmlFor={fieldId('photo-interval')}>Photo interval</label>
            <input id={fieldId('photo-interval')} type="number" min={1 / perUnit} max={720 / perUnit}
              step={1 / perUnit} className={`w-24 ${CONTROL}`} disabled={disabled}
              value={shown(frames)}
              onChange={e => { const next = Math.round(Number(e.target.value) * perUnit); if (next >= 1 && next <= 720) save({ intervalFrames: next }); }} />
          </>}
          <label htmlFor={fieldId('photo-overlap')}>Overlap</label>
          <input id={fieldId('photo-overlap')} type="number" min={0} max={PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES / perUnit}
            step={1 / perUnit} className={`w-24 ${CONTROL}`} disabled={disabled} value={shown(overlap)}
            onChange={e => { const next = Math.round(Number(e.target.value) * perUnit); if (next >= 0 && next <= PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES) save({ overlapFrames: next }); }} />
          <label className="sr-only" htmlFor={fieldId('photo-unit')}>Photo interval unit</label>
          <select id={fieldId('photo-unit')} value={unit} disabled={disabled} className={CONTROL} onChange={e => setUnit(e.target.value)}>
            <option value="frames">Frames</option><option value="seconds">Seconds</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={CONTROL} disabled={disabled || !entries.length}
            onClick={() => save({ layouts: photoStackLayouts(entries.length), ...(overlap ? {} : { overlapFrames: Math.min(PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES, frames * 2) }) })}>
            Photo stack layout
          </button>
          <button type="button" className={CONTROL} disabled={disabled || !hasLayouts(sequence)} onClick={() => save({ layouts: [] })}>All full frame</button>
        </div>
        {editing != null && entries[editing] && (
          <fieldset className="space-y-1 rounded border border-port-border p-2" data-testid="photo-layout-editor">
            <legend className="px-1 text-xs">Photo {formatCount(editing + 1)} layout</legend>
            {editingLayout ? <>
              <div className="flex flex-wrap gap-2">
                {LAYOUT_FIELDS.map(({ key, label, unit: suffix, factor, step }) => {
                  const range = PHOTO_LAYOUT_RANGES[key];
                  return <div key={key} className="flex items-center gap-1 text-xs">
                    <label htmlFor={fieldId(`photo-layout-${key}`)}>{label}</label>
                    <input id={fieldId(`photo-layout-${key}`)} type="number" className={`w-20 ${CONTROL}`} disabled={disabled}
                      min={range.min * factor} max={range.max * factor} step={step} value={Number((editingLayout[key] * factor).toFixed(2))}
                      onChange={e => {
                        const value = Number(e.target.value) / factor;
                        if (Number.isFinite(value) && value >= range.min && value <= range.max) setLayout(editing, { ...editingLayout, [key]: value });
                      }} />
                    <span aria-hidden="true">{suffix}</span>
                  </div>;
                })}
              </div>
              <button type="button" className={CONTROL} disabled={disabled} onClick={() => setLayout(editing, null)}>Full frame</button>
            </> : (
              <button type="button" className={CONTROL} disabled={disabled} onClick={() => setLayout(editing, { ...DEFAULT_PHOTO_LAYOUT, scale: 0.6 })}>Lay out this photo</button>
            )}
          </fieldset>
        )}
        <p className="text-[11px] text-port-text-muted">
          {rate === 'frames' || !beats.length ? `${formatCount(frames)} frames / ${(frames / fps).toFixed(3)}s per photo at ${formatCount(fps)} fps. ` : `${BEAT_TOGGLE_RATE_LABELS[rate]} on the song grid. `}
          {overlap ? `Each photo stays ${formatCount(overlap)} frames / ${(overlap / fps).toFixed(3)}s beneath the next. ` : ''}
          Repeats in order within this shot; later photos lie on top. Audio and shot length stay the same.
        </p>
        {!entries.length && <p role="alert" className="text-xs text-port-warning">Add photos before previewing or rendering.</p>}
      </>}
      {picking && <GalleryImagePicker open onClose={() => setPicking(false)} onSelect={item => add(item.filename)} />}
    </div>
  );
}
