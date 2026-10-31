import { useState } from 'react';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideoGreybox.js';
import MediaImage from '../MediaImage';

/** An explicit set/camera choice. Loading and missing captures remain visible. */
export default function SceneGreyboxReference({ project, scene, places = {}, onChange, onSaving, disabled = false }) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [missingCapture, setMissingCapture] = useState(null);
  const sets = (project?.concept?.subjects || []).filter((s) => s.kind === 'place' && s.ingredientId);
  const selected = scene.setReference;
  const subject = sets.find((s) => s.id === selected?.subjectId);
  const entry = subject && places[subject.ingredientId];
  const shots = entry?.ingredient?.payload?.greybox?.shots || [];
  const context = musicVideoGreyboxReference(project, scene, places);
  if (!sets.length && !selected) return null;
  const id = `greybox-${scene.sceneId}`;
  const save = async (value) => {
    setSaving(true);
    onSaving?.(true);
    setSaveError('');
    try {
      const saved = await onChange(value);
      if (saved === false) setSaveError('Selection was not saved. Try again.');
    } catch (err) {
      setSaveError(err?.message || 'Selection was not saved. Try again.');
    } finally { setSaving(false); onSaving?.(false); }
  };
  return (
    <fieldset disabled={disabled || saving} className="space-y-1 rounded border border-port-border p-2">
      <legend className="text-xs font-medium">Greybox layout reference</legend>
      <div className="flex flex-wrap gap-2">
        <label htmlFor={`${id}-set`} className="text-xs">Set</label>
        <select id={`${id}-set`} value={selected?.subjectId || ''} onChange={(e) => save(e.target.value ? { subjectId: e.target.value } : null)} className="min-h-[44px] max-w-full rounded border border-port-border bg-port-bg text-xs">
          <option value="">No greybox reference</option>
          {selected && !subject && <option value={selected.subjectId}>Missing set</option>}
          {sets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
        </select>
        {subject && <>
          <label htmlFor={`${id}-shot`} className="text-xs">Camera shot</label>
          <select id={`${id}-shot`} value={selected.greyboxShotId || ''} onChange={(e) => save({ subjectId: subject.id, ...(e.target.value ? { greyboxShotId: e.target.value } : {}) })} className="min-h-[44px] max-w-full rounded border border-port-border bg-port-bg text-xs">
            <option value="">Choose a saved camera shot</option>
            {selected.greyboxShotId && !shots.some((s) => s.id === selected.greyboxShotId) && <option value={selected.greyboxShotId}>Missing camera shot</option>}
            {shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.label}</option>)}
          </select>
        </>}
      </div>
      {subject && !entry && <p className="text-xs text-port-warning">{places[subject.ingredientId] === undefined ? 'Loading set cameras…' : 'Unable to load this set.'}</p>}
      {saveError && <p role="alert" className="text-xs text-port-error">{saveError}</p>}
      {context?.error && <p role="alert" className="text-xs text-port-error">{context.error}</p>}
      {context?.reference?.imageId === missingCapture && <p role="alert" className="text-xs text-port-error">The greybox capture file could not be loaded. Capture this camera again before rendering.</p>}
      {context?.reference && <figure className="flex items-center gap-2 text-xs">
        <MediaImage thumbnail src={`/data/images/${encodeURIComponent(context.reference.imageId)}`} alt={context.reference.label} onError={() => setMissingCapture(context.reference.imageId)} onLoad={() => setMissingCapture((missing) => missing === context.reference.imageId ? null : missing)} className="h-20 w-32 rounded object-contain" />
        <figcaption>{context.reference.label} · sent as a set reference</figcaption>
      </figure>}
    </fieldset>
  );
}
