import { useEffect, useId, useState } from 'react';
import {
  IMAGE_TREATMENT_FORMATS, IMAGE_TREATMENT_POSITIONS, IMAGE_TREATMENT_PRESETS, IMAGE_TREATMENT_RANGES,
  imageTreatmentDateText, imageTreatmentDefaults, isImageTreatmentDate, shotImageTreatment, shotTreatmentImages,
} from '../../../../server/lib/musicVideo/musicVideoImageTreatments.js';
import ShotEditorGroup from './ShotEditorGroup.jsx';
import { shotTreatmentUrl } from './sceneImageTreatmentUrls.js';

const control = 'min-w-0 w-full rounded border border-port-border bg-port-bg px-2 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-0';
const selectOptions = (entries) => entries.map(([value, name]) => <option key={value} value={value}>{name}</option>);

function RangeControl({ label, value, name, onChange }) {
  const id = useId();
  const [min, max] = IMAGE_TREATMENT_RANGES[name];
  return (
    <div className="min-w-0">
      <label className="flex justify-between gap-1" htmlFor={id}>{label}<span className="tabular-nums">{Math.round(value * 100)}%</span></label>
      <input id={id} className="w-full min-h-8" type="range" min={min} max={max} step={name === 'size' ? 0.001 : 0.01}
        value={value} onChange={e => onChange({ [name]: Number(e.target.value) })} />
    </div>
  );
}

function Controls({ value, onChange }) {
  const formats = Object.entries(IMAGE_TREATMENT_FORMATS).filter(([key]) => value.type === 'print' || ['ymd', 'mdy', 'dmy'].includes(key));
  const isPrint = value.type === 'print';
  return (
    <>
      <p className="text-port-text-muted">{IMAGE_TREATMENT_PRESETS[value.type].description}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label>{isPrint ? 'Processing date' : 'Exposure date'}
          <input type="date" className={control} value={value.date} onChange={e => onChange({ date: e.target.value })} />
        </label>
        <label>Format<select className={control} value={value.format} onChange={e => onChange({ format: e.target.value })}>{selectOptions(formats)}</select></label>
        <label>Position<select className={control} value={value.position} onChange={e => onChange({ position: e.target.value })}>
          {selectOptions(Object.entries(IMAGE_TREATMENT_POSITIONS))}
        </select></label>
        <label>Color<input type="color" className={control} value={value.color} onChange={e => onChange({ color: e.target.value })} /></label>
        {!isPrint && <div className="col-span-2 flex flex-wrap items-end gap-1" aria-label="Period colors">
          {[['Orange', '#ff8528'], ['Red', '#ff4c34'], ['Yellow', '#ffd05d']].map(([label, color]) => (
            <button type="button" key={color} className="rounded border border-port-border px-2 py-1 min-h-[44px] pointer-fine:sm:min-h-0"
              aria-pressed={color === value.color} onClick={() => onChange({ color })}>
              <span className="mr-1 inline-block size-2 rounded-full" style={{ background: color }} aria-hidden="true" />{label}
            </button>
          ))}
        </div>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <RangeControl label="Size" name="size" value={value.size} onChange={onChange} />
        <RangeControl label="Opacity" name="opacity" value={value.opacity} onChange={onChange} />
        <RangeControl label={isPrint ? 'Ink wear' : 'Bloom intensity'} name="intensity" value={value.intensity} onChange={onChange} />
      </div>
    </>
  );
}

function LivePreview({ projectId, sceneId, imageId, value }) {
  const [original, setOriginal] = useState(false);
  const [failed, setFailed] = useState(null);
  const chosen = !original && value && isImageTreatmentDate(value.date) ? value : null;
  const url = shotTreatmentUrl(projectId, sceneId, imageId, chosen);
  const [visible, setVisible] = useState(url);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(url), 140);
    return () => clearTimeout(timer);
  }, [url]);
  return (
    <div className="space-y-1">
      <img src={visible} alt="Image treatment preview" loading="lazy" onError={() => setFailed(visible)} onLoad={() => setFailed(null)}
        className="block max-h-64 w-full rounded border border-port-border bg-black object-contain" />
      <div className="flex items-center justify-between gap-1 text-port-text-muted">
        <label className="flex min-h-8 items-center gap-1">
          <input type="checkbox" checked={original} disabled={!value} onChange={e => setOriginal(e.target.checked)} /> Compare original
        </label>
        {chosen && <output>{imageTreatmentDateText(chosen)}</output>}
      </div>
      {failed === visible && <p role="status" className="text-port-error">Preview unavailable. Check that this image is on this machine.</p>}
    </div>
  );
}

function TreatmentEditor({ projectId, scene, imageId, onSave }) {
  const saved = shotImageTreatment(scene, imageId);
  const [draft, setDraft] = useState(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const value = draft === undefined ? saved : draft;
  const changed = JSON.stringify(value) !== JSON.stringify(saved);
  const update = (patch) => setDraft({ ...value, ...patch });
  const save = async () => {
    setSaving(true);
    setError(false);
    try {
      const rest = (scene.imageTreatments || []).filter(item => item.imageId !== imageId);
      const result = await onSave(scene.sceneId, { imageTreatments: value ? [...rest, value] : rest });
      if (result === false) setError(true);
      else setDraft(undefined);
    } catch { setError(true); }
    finally { setSaving(false); }
  };
  return (
    <fieldset className="min-w-0 space-y-2" disabled={saving}>
      <label className="block">Treatment
        <select className={control} value={value?.type || 'none'} onChange={e => {
          const next = imageTreatmentDefaults(e.target.value, imageId);
          setDraft(next && value && isImageTreatmentDate(value.date) ? { ...next, date: value.date } : next);
        }}>
          <option value="none">None</option>
          {selectOptions(Object.entries(IMAGE_TREATMENT_PRESETS).map(([key, preset]) => [key, preset.label]))}
        </select>
      </label>
      {value && <Controls value={value} onChange={update} />}
      <LivePreview projectId={projectId} sceneId={scene.sceneId} imageId={imageId} value={value} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded bg-port-accent px-2 py-1.5 text-port-bg disabled:opacity-50 min-h-[44px] pointer-fine:sm:min-h-0"
          disabled={!changed || (value && !isImageTreatmentDate(value.date))} onClick={save}>{saving ? 'Saving…' : 'Save treatment'}</button>
        {changed && <button type="button" className="rounded border border-port-border px-2 py-1.5" onClick={() => { setDraft(undefined); setError(false); }}>Discard edits</button>}
        {error && <p role="alert" className="text-port-error">Treatment wasn’t saved. Try again.</p>}
      </div>
    </fieldset>
  );
}

export default function SceneImageTreatments({ project, scene, onSave }) {
  const images = shotTreatmentImages(scene);
  const [picked, setPicked] = useState(null);
  if (!project?.id || !images.length || !onSave) return null;
  const id = images.some(image => image.id === picked) ? picked : images[0].id;
  const count = images.filter(image => shotImageTreatment(scene, image.id)).length;
  return (
    <ShotEditorGroup title="Image Treatments" summary={count ? `${count} treated` : 'none'} defaultOpen={false} testId="shot-group-image-treatments">
      <div className="space-y-2 text-xs">
        <label className="block">Image
          <select className={control} value={id} onChange={e => setPicked(e.target.value)}>
            {selectOptions(images.map(image => [image.id, `${image.label} · ${image.id}`]))}
          </select>
        </label>
        <p className="text-port-text-muted">Only this shot’s use of this image is treated. The original stays intact. Still renders update; existing clips need a new take.</p>
        <TreatmentEditor key={id} projectId={project.id} scene={scene} imageId={id} onSave={onSave} />
      </div>
    </ShotEditorGroup>
  );
}
