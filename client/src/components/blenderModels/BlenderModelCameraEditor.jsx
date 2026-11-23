import { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import MediaImage from '../MediaImage';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { BLENDER_MODEL_FIXED_VIEWS, approvedReferenceFilename, defaultOrbitDistance, referenceImageUrls, referenceLabel } from '../../lib/blenderModels.js';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';

const CROP_FIELDS = [['x', 'Left'], ['y', 'Top'], ['width', 'Width'], ['height', 'Height']];
const ORBIT_FIELDS = [['azimuth', 'Azimuth (degrees, 0 front, 90 right)', -360, 360], ['elevation', 'Elevation (degrees, 90 top)', -90, 90], ['distance', 'Distance (meters)', 0.0001, 10000], ['lens', 'Lens (mm)', 1, 1000]];
const percent = (value) => String(Number((value * 100).toFixed(1)));
const clamp = (value) => Math.min(1, Math.max(0, value));

// Percent fields to 0-1 fractions: null when the panel is the whole image, undefined when the numbers make no panel.
function cropFrom(fields) {
  const crop = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value) / 100]));
  if (!Object.values(crop).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
  if (crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) return undefined;
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1 ? null : crop;
}

// Drag on the reference to draw the panel; the percent fields below do the same from the keyboard.
function CropBox({ filename, fields, onChange }) {
  const [start, setStart] = useState(null);
  const point = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };
  const draw = (event) => {
    if (!start) return;
    const end = point(event);
    // A click is not a panel.
    if (Math.abs(end.x - start.x) < 0.01 || Math.abs(end.y - start.y) < 0.01) return;
    // Rounded edges, so the width never reaches past the image.
    const span = (a, b) => [Math.min(a, b), Math.max(a, b)].map((value) => Math.round(value * 1000) / 1000);
    const [left, right] = span(start.x, end.x);
    const [top, bottom] = span(start.y, end.y);
    onChange({ x: percent(left), y: percent(top), width: percent(right - left), height: percent(bottom - top) });
  };
  const [src, fallback] = referenceImageUrls(filename);
  return (
    <div className="relative inline-block max-w-full touch-none select-none"
      onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); setStart(point(event)); }}
      onPointerMove={draw} onPointerUp={(event) => { draw(event); setStart(null); }} onPointerCancel={() => setStart(null)}>
      <MediaImage src={src} fallbackSrc={fallback} alt="Reference to crop" draggable={false} className="block max-h-[50dvh] max-w-full" />
      <div aria-hidden="true" className="pointer-events-none absolute border-2 border-port-accent bg-port-accent/10"
        style={{ left: `${fields.x || 0}%`, top: `${fields.y || 0}%`, width: `${fields.width || 0}%`, height: `${fields.height || 0}%` }} />
    </div>
  );
}

const startingFields = (camera, referenceId, size) => ({
  label: camera?.label ?? '',
  referenceId: camera?.referenceId ?? referenceId ?? 'overall',
  kind: camera?.orbit ? 'orbit' : camera?.view ?? 'front',
  partId: camera?.orbit?.partId ?? '',
  orbit: Object.fromEntries(Object.entries({ azimuth: 35, elevation: 25, distance: defaultOrbitDistance(size), lens: 50, ...camera?.orbit })
    .filter(([key]) => ORBIT_FIELDS.some(([field]) => field === key)).map(([key, value]) => [key, String(value)])),
  crop: Object.fromEntries(CROP_FIELDS.map(([key]) => [key, percent(camera?.crop?.[key] ?? (key === 'width' || key === 'height' ? 1 : 0))])),
});

/** Add or change one compare camera: which panel of which reference, and where the render is seen from. Mount it keyed by the camera id. */
export default function BlenderModelCameraEditor({ model, camera, referenceId, parts, onSaved, onClose }) {
  const { state, pending } = model;
  const [fields, setFields] = useState(() => startingFields(camera, referenceId, state.describe?.sizeMeters));
  const [removing, setRemoving] = useState(false);
  const set = (patch) => setFields((current) => ({ ...current, ...patch }));
  const crop = cropFrom(fields.crop);
  const orbit = Object.fromEntries(Object.entries(fields.orbit).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)]));
  const orbitOk = ORBIT_FIELDS.every(([key,, min, max]) => Number.isFinite(orbit[key]) && orbit[key] >= min && orbit[key] <= max);
  const slot = state.references.find((entry) => entry.id === fields.referenceId);
  const filename = approvedReferenceFilename(slot);
  const problem = !fields.label.trim() ? 'Name the camera.' : crop === undefined ? 'The panel must lie inside the reference: percentages from 0 to 100, with some width and height.'
    : fields.kind === 'orbit' && !orbitOk ? 'Enter every orbit number: elevation from -90 to 90, distance above 0, lens from 1 to 1000.' : null;
  const save = async (event) => {
    event.preventDefault();
    if (problem || pending.camera) return;
    // The saved aim point stays unless the part it aims at changes.
    const target = camera?.orbit?.target && (camera.orbit.partId ?? '') === fields.partId ? { target: camera.orbit.target } : {};
    const input = {
      label: fields.label.trim(), referenceId: fields.referenceId, crop,
      ...(fields.kind === 'orbit' ? { orbit: { ...orbit, partId: fields.partId || null, ...target } } : { view: fields.kind }),
    };
    const result = camera ? await model.updateCamera(camera.id, input) : await model.addCamera(input);
    if (result.ok) onSaved(camera?.id ?? result.answer.cameras.at(-1).id);
  };

  return (
    <form aria-label={camera ? 'Edit camera' : 'New camera'} onSubmit={save} className="min-w-0 space-y-3 rounded border border-port-border p-3">
      <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-3">
        <div className="min-w-0">
          <label htmlFor="bm-cam-label" className={labelCls}>Camera name</label>
          <input id="bm-cam-label" className={inputCls} value={fields.label} maxLength={80} onChange={(event) => set({ label: event.target.value })} />
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-cam-ref" className={labelCls}>Reference</label>
          <select id="bm-cam-ref" className={inputCls} value={fields.referenceId} onChange={(event) => set({ referenceId: event.target.value })}>
            {state.references.map((entry) => <option key={entry.id} value={entry.id}>{referenceLabel(entry)}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-cam-view" className={labelCls}>Seen from</label>
          <select id="bm-cam-view" className={inputCls} value={fields.kind} onChange={(event) => set({ kind: event.target.value })}>
            {BLENDER_MODEL_FIXED_VIEWS.map((view) => <option key={view.id} value={view.id}>{view.label}</option>)}
            <option value="orbit">Orbit (close-up)</option>
          </select>
        </div>
      </div>
      {fields.kind === 'orbit' && (
        <div className="grid min-w-0 grid-cols-1 gap-2 @md:grid-cols-2 @3xl:grid-cols-5">
          {ORBIT_FIELDS.map(([key, label]) => (
            <div key={key} className="min-w-0">
              <label htmlFor={`bm-cam-${key}`} className={labelCls}>{label}</label>
              <input id={`bm-cam-${key}`} type="number" step="any" className={inputCls} value={fields.orbit[key]} onChange={(event) => set({ orbit: { ...fields.orbit, [key]: event.target.value } })} />
            </div>
          ))}
          <div className="min-w-0">
            <label htmlFor="bm-cam-part" className={labelCls}>Aimed at</label>
            <select id="bm-cam-part" className={inputCls} value={fields.partId} onChange={(event) => set({ partId: event.target.value })}>
              <option value="">Whole model</option>
              {fields.partId && !parts.some((part) => part.id === fields.partId) && <option value={fields.partId}>{fields.partId} (not in this build)</option>}
              {parts.map((part, index) => <option key={`${part.id}:${index}`} value={part.id}>{part.label || part.id}</option>)}
            </select>
          </div>
        </div>
      )}
      <fieldset className="min-w-0 space-y-1.5">
        <legend className={labelCls}>Panel of the reference this camera matches (percent of the image)</legend>
        {filename ? <CropBox filename={filename} fields={fields.crop} onChange={(next) => set({ crop: next })} />
          : <p className="text-xs text-port-text-muted">This reference has no approved image yet, so there is nothing to draw on.</p>}
        <div className="grid min-w-0 grid-cols-2 gap-2 @xl:grid-cols-4">
          {CROP_FIELDS.map(([key, label]) => (
            <div key={key} className="min-w-0">
              <label htmlFor={`bm-crop-${key}`} className={labelCls}>{label}</label>
              <input id={`bm-crop-${key}`} type="number" step="any" className={inputCls} value={fields.crop[key]} onChange={(event) => set({ crop: { ...fields.crop, [key]: event.target.value } })} />
            </div>
          ))}
        </div>
      </fieldset>
      {problem && <p role="status" className="text-xs text-port-text-muted">{problem}</p>}
      <div className="flex flex-wrap gap-1.5">
        <button type="submit" className={primaryCls} disabled={!!problem || !!pending.camera}><Save size={14} aria-hidden="true" /> {pending.camera ? 'Saving…' : 'Save camera'}</button>
        <button type="button" className={buttonCls} onClick={onClose}>Cancel</button>
        {camera && <button type="button" className={buttonCls} onClick={() => setRemoving(true)}><Trash2 size={14} aria-hidden="true" /> Remove camera</button>}
      </div>
      {removing && (
        <InlineConfirmRow autoFocus aria-label={`Confirm removing ${camera.label}`} question={`Remove the "${camera.label}" camera?`}
          onConfirm={async () => { setRemoving(false); if ((await model.removeCamera(camera.id)).ok) onClose(); }} onCancel={() => setRemoving(false)} />
      )}
    </form>
  );
}
