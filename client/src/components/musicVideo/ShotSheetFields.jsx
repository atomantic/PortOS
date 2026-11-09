import { useState } from 'react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea.jsx';
import { SHOT_CAMERA_SET_DOWN, normalizeShotSheet, shotSheetCast, shotSheetOptions } from '../../../../server/lib/musicVideoShotSheet.js';

const inputCls = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0';
const labelCls = 'block text-[11px] text-port-text-muted';

/** A text box that commits on blur, only when its text changed; a save elsewhere replaces what's shown. */
function FieldText({ id, label, value = '', rows = 1, list, maxLength, disabled, onCommit }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  if (value !== saved) { setSaved(value); setDraft(value); }
  const props = { value: draft, disabled, maxLength, className: inputCls, onChange: (e) => setDraft(e.target.value), onBlur: () => { if (draft !== value) onCommit(draft); } };
  return list
    ? <input id={id} aria-label={label} list={list} {...props} />
    : <AutoSizeTextarea id={id} aria-label={label} rows={rows} {...props} />;
}

/**
 * A sheet-built shot's ingredients in the shot editor: the same columns as the
 * shot sheet (camera and holder, view, place, time and light, who, action,
 * emotion, notes), each saved to `scene.shotSheet` as you leave it.
 */
export default function ShotSheetFields({ project, scene, disabled = false, onChange }) {
  const sheet = scene.shotSheet || {};
  const id = (name) => `mv-scene-${scene.sceneId}-sheet-${name}`;
  const save = (next) => onChange({ shotSheet: normalizeShotSheet(next) });
  const setField = (field, value) => save({ ...sheet, [field]: value });
  const cameras = project?.cameras || [];
  const camera = cameras.find((entry) => entry.id === sheet.cameraId) || null;
  const cast = shotSheetCast(project);
  const text = (field, label, { rows = 1, maxLength, pick = false } = {}) => (
    <div className="min-w-0">
      <label htmlFor={id(field)} className={labelCls}>{label}</label>
      <FieldText id={id(field)} label={label} value={sheet[field] || ''} rows={rows} maxLength={maxLength} disabled={disabled}
        list={pick ? id(`${field}-options`) : undefined} onCommit={(value) => setField(field, value)} />
      {pick && <datalist id={id(`${field}-options`)}>{shotSheetOptions(project, field).map((value) => <option key={value} value={value} />)}</datalist>}
    </div>
  );
  return (
    <fieldset className="min-w-0 space-y-1.5" aria-label="Shot details">
      <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={id('camera')} className={labelCls}>Capture camera</label>
          <select id={id('camera')} value={sheet.cameraId || ''} disabled={disabled} className={inputCls}
            onChange={(e) => {
              const next = cameras.find((entry) => entry.id === e.target.value);
              // An observer has nobody behind it, so changing to one clears the holder.
              save({ ...sheet, cameraId: e.target.value || null, holder: next?.kind === 'observer' ? null : sheet.holder });
            }}>
            <option value="">No camera set</option>
            {cameras.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
        {camera?.kind !== 'observer' && (
          <div className="min-w-0">
            <label htmlFor={id('holder')} className={labelCls}>Held by</label>
            <select id={id('holder')} value={sheet.holder || ''} disabled={disabled || !camera} className={inputCls}
              onChange={(e) => setField('holder', e.target.value || null)}>
              <option value="">Nobody set</option>
              {cast.map((name) => <option key={name} value={name}>{name}</option>)}
              <option value={SHOT_CAMERA_SET_DOWN}>Set down, nobody holding</option>
            </select>
          </div>
        )}
        {text('view', 'View', { maxLength: 1000, pick: true })}
        {text('location', 'Location', { maxLength: 200, pick: true })}
        {text('timeOfDay', 'Time of day', { maxLength: 100, pick: true })}
        {text('light', 'Light', { maxLength: 300, pick: true })}
      </div>
      {cast.length > 0 && (
        <div role="group" aria-label="Who" className="flex min-w-0 flex-wrap items-center gap-1">
          <span className={labelCls}>Who</span>
          {cast.map((name) => {
            const on = (sheet.characters || []).includes(name);
            return (
              <button key={name} type="button" aria-pressed={on} disabled={disabled}
                onClick={() => setField('characters', on ? (sheet.characters || []).filter((entry) => entry !== name) : [...(sheet.characters || []), name])}
                className={`min-h-[44px] rounded-full border px-2 py-0.5 text-xs pointer-fine:sm:min-h-0 ${on ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}>{name}</button>
            );
          })}
        </div>
      )}
      {text('action', 'Action', { rows: 2, maxLength: 2000 })}
      {text('emotion', 'Emotion', { maxLength: 300, pick: true })}
      {text('notes', 'Notes', { rows: 2, maxLength: 2000 })}
    </fieldset>
  );
}
