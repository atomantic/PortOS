import { useId, useState } from 'react';
import { newGreyboxItem, withoutGreyboxItem } from '../../lib/greybox';

const inputClass = 'w-full min-w-0 min-h-[44px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white';
const buttonClass = 'min-h-[44px] rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent disabled:opacity-40';
const collections = [['parts', 'Parts'], ['anchors', 'Anchors'], ['landmarks', 'Landmarks'], ['zones', 'Zones']];

function Field({ label, value, onChange, numeric = false, ...props }) {
  const id = useId();
  return (
    <label htmlFor={id} className="block min-w-0 text-xs text-gray-400">{label}
      <input id={id} className={inputClass} type={numeric ? 'number' : 'text'} step={numeric ? '0.1' : undefined} value={value}
        onChange={(e) => onChange(numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} {...props} />
    </label>
  );
}

function Picker({ label, value, onChange, children }) {
  const id = useId();
  return <label htmlFor={id} className="block text-xs text-gray-400">{label}<select id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select></label>;
}

function VectorFields({ label, value, onChange, axes = ['X', 'Y', 'Z'], positive = false }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs text-gray-400">{label}</legend>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {value.map((entry, index) => <Field key={axes[index]} label={`${label} ${axes[index]}`} value={entry} numeric min={positive ? 0.1 : -1000} max={1000}
          onChange={(next) => onChange(value.map((old, i) => i === index ? next : old))} />)}
      </div>
    </fieldset>
  );
}

function ItemFields({ collection, item, scene, update }) {
  return (
    <div className="space-y-2">
      <Field label="Label" value={item.label ?? ''} onChange={(label) => update({ label })} maxLength={120} />
      {item.position && <VectorFields label="Position (m)" value={item.position} onChange={(position) => update({ position })} />}
      {collection === 'parts' && <>
        <Picker label="Zone" value={item.zone || ''} onChange={(zone) => update({ zone: zone || undefined })}>
          <option value="">No zone</option>{scene.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
        </Picker>
        <VectorFields label="Rotation (degrees)" value={item.rotationDegrees} onChange={(rotationDegrees) => update({ rotationDegrees })} />
        {item.size && <VectorFields label="Size (m)" value={item.size} axes={item.type === 'plane' ? ['X', 'Z'] : undefined} positive onChange={(size) => update({ size })} />}
        {item.radius !== undefined && <Field label="Radius (m)" value={item.radius} numeric min={0.1} max={1000} onChange={(radius) => update({ radius })} />}
        {item.height !== undefined && <Field label="Height (m)" value={item.height} numeric min={0.1} max={1000} onChange={(height) => update({ height })} />}
        {item.outline?.map((point, index) => <VectorFields key={index} label={`Outline point ${index + 1} (m)`} value={point} axes={['X', 'Z']}
          onChange={(next) => update({ outline: item.outline.map((old, i) => i === index ? next : old) })} />)}
      </>}
      {collection === 'anchors' && <>
        <Picker label="Kind" value={item.kind} onChange={(kind) => update({ kind })}><option value="figure">Figure</option><option value="prop">Prop</option></Picker>
        <Field label="Facing (degrees)" value={item.facingDegrees} numeric min={-360} max={360} onChange={(facingDegrees) => update({ facingDegrees })} />
        <Field label="Height (m)" value={item.heightMeters} numeric min={0.1} max={50} onChange={(heightMeters) => update({ heightMeters })} />
      </>}
      {collection === 'landmarks' && <Field label="Note" value={item.note || ''} maxLength={300} onChange={(note) => update({ note })} />}
      {collection === 'zones' && <Field label="Color" type="color" value={item.color} onChange={(color) => update({ color })} />}
    </div>
  );
}

export default function GreyboxEditor({ scene, shotId, selected, onSelect, onChange, disabled }) {
  const [partType, setPartType] = useState('box');
  const shot = scene.shots.find((item) => item.id === shotId);
  const updateFigures = (figures) => onChange({ ...scene, shots: scene.shots.map((item) => item.id === shotId ? { ...item, figures } : item) });
  return (
    <fieldset disabled={disabled} className="space-y-3 min-w-0">
      <legend className="text-sm font-medium text-white mb-2">Edit layout by hand</legend>
      {collections.map(([key, title]) => <details key={key} className="rounded-lg border border-port-border p-3">
        <summary className="cursor-pointer text-sm text-white min-h-[32px]">{title} ({scene[key].length})</summary>
        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap items-end gap-2">
            {key === 'parts' && <Picker label="New part shape" value={partType} onChange={setPartType}>{['box', 'plane', 'cylinder', 'extrude'].map((type) => <option key={type} value={type}>{type}</option>)}</Picker>}
            <button type="button" className={buttonClass} onClick={() => {
              const item = newGreyboxItem(scene, key, partType);
              onChange({ ...scene, [key]: [...scene[key], item] });
              onSelect(`${key}:${item.id}`);
            }}>Add {key === 'parts' ? 'part' : key.slice(0, -1)}</button>
          </div>
          {scene[key].map((item) => <div key={item.id} className={`rounded-lg border p-2 space-y-2 ${selected === `${key}:${item.id}` ? 'border-port-accent' : 'border-port-border'}`}>
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" className={`${buttonClass} min-w-0 break-all text-left`} aria-pressed={selected === `${key}:${item.id}`} onClick={() => onSelect(`${key}:${item.id}`)}>{item.label || item.id}</button>
              <button type="button" className={buttonClass} aria-label={`Remove ${key.slice(0, -1)} ${item.label || item.id}`} disabled={key === 'parts' && scene.source === 'spec' && scene.parts.length === 1}
                onClick={() => { onChange(withoutGreyboxItem(scene, key, item.id)); if (selected === `${key}:${item.id}`) onSelect(''); }}>Remove</button>
            </div>
            {selected === `${key}:${item.id}` && <ItemFields collection={key} item={item} scene={scene}
              update={(patch) => onChange({ ...scene, [key]: scene[key].map((old) => old.id === item.id ? { ...old, ...patch } : old) })} />}
          </div>)}
        </div>
      </details>)}
      {shot && <details className="rounded-lg border border-port-border p-3">
        <summary className="cursor-pointer text-sm text-white min-h-[32px]">Figures in “{shot.label}”</summary>
        <p className="text-xs text-gray-400 my-2">Choose the anchors that appear in this shot. Removing an anchor also removes it from every shot.</p>
        {scene.anchors.length === 0 && <p className="text-xs text-gray-400">Add an anchor first.</p>}
        {scene.anchors.map((anchor) => <FigureRow key={anchor.id} anchor={anchor} figure={shot.figures.find((figure) => figure.anchorId === anchor.id)}
          onToggle={(checked) => updateFigures(checked ? [...shot.figures, { anchorId: anchor.id, pose: '' }] : shot.figures.filter((figure) => figure.anchorId !== anchor.id))}
          onPose={(pose) => updateFigures(shot.figures.map((figure) => figure.anchorId === anchor.id ? { ...figure, pose } : figure))} />)}
      </details>}
    </fieldset>
  );
}

function FigureRow({ anchor, figure, onToggle, onPose }) {
  const id = useId();
  return <div className="space-y-2 py-2">
    <label htmlFor={id} className="flex items-center gap-2 min-h-[44px] text-sm text-gray-200"><input id={id} type="checkbox" checked={!!figure} onChange={(e) => onToggle(e.target.checked)} />{anchor.label}</label>
    {figure && <Field label={`Pose for ${anchor.label}`} value={figure.pose || ''} maxLength={120} onChange={onPose} />}
  </div>;
}
