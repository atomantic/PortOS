import { useState } from 'react';
import { ImagePlus, Trash2, Plus, Palette } from 'lucide-react';
import useFieldDraft from '../../hooks/useFieldDraft.js';
import MoodBoardReferenceStrip from '../moodBoard/MoodBoardReferenceStrip.jsx';
import { MAX_CONDITIONING_REFERENCES } from '../../hooks/useMusicVideoSceneMedia.js';

const ROLES = [
  ['mood', 'Mood'], ['character', 'Character'], ['wardrobe', 'Wardrobe'],
  ['set', 'Set'], ['prop', 'Prop'], ['style', 'Style'],
];
const MAX_PALETTE = 12;
const MAX_REFERENCES = 24;

/**
 * The project's reusable visual specification (#8965): moodboard/reference
 * images with a role (character, wardrobe, set, …), a palette, typography and
 * camera rules. Palette/camera/typography are appended to every generated
 * prompt; references ticked "Condition frames" are sent to reference-frame
 * renders as real conditioning images, not just prose.
 *
 * `onSave(patch)` persists a partial `visualSpec` (the server merges it per
 * sub-field); `references` and `palette` are always sent whole. Keyed by the
 * project id at the call site, so a draft never carries across projects.
 */
export default function VisualSpecPanel({ project, onSave, onAddReference }) {
  const spec = project.visualSpec || {};
  const references = spec.references || [];
  const palette = spec.palette || [];
  const [color, setColor] = useState('#336699');
  const typography = useFieldDraft(spec.typography, (v) => onSave({ typography: v }));
  const cameraRules = useFieldDraft(spec.cameraRules, (v) => onSave({ cameraRules: v }));
  const idFor = (suffix) => `mv-spec-${project.id}-${suffix}`;

  const saveReferences = (next) => onSave({ references: next });
  const updateRef = (id, patch) => saveReferences(references.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const flagged = references.filter((r) => r.condition).length;

  return (
    <details className="mt-2 rounded border border-port-border bg-port-bg/40 p-2 group">
      <summary className="cursor-pointer text-xs text-port-text-muted select-none min-h-[32px] flex items-center gap-2">
        <Palette size={13} />
        <span>Visual spec</span>
        <span>· {references.length} reference{references.length === 1 ? '' : 's'}</span>
        {flagged > 0 && <span className="text-port-accent">· {flagged} conditioning</span>}
        {palette.length > 0 && (
          <span className="flex gap-0.5" aria-hidden="true">
            {palette.map((c) => <span key={c} className="inline-block w-3 h-3 rounded-sm border border-port-border" style={{ backgroundColor: c }} />)}
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-port-text-muted">References</span>
            <button type="button" onClick={onAddReference} disabled={references.length >= MAX_REFERENCES}
              className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
              <ImagePlus size={13} /> Add reference
            </button>
          </div>
          {references.length === 0 && (
            <p className="text-[11px] text-port-text-muted">
              Add character, wardrobe, set or mood images. Tick &ldquo;Condition frames&rdquo; to send one to every reference-frame render.
            </p>
          )}
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {references.map((ref) => (
              <li key={ref.id} className="flex gap-2 rounded border border-port-border p-1.5 min-w-0">
                <img src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt="" loading="lazy" className="w-16 h-16 object-cover rounded shrink-0 bg-black" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex gap-1">
                    <label htmlFor={idFor(`role-${ref.id}`)} className="sr-only">Reference role</label>
                    <select id={idFor(`role-${ref.id}`)} value={ref.role || 'mood'}
                      onChange={(e) => updateRef(ref.id, { role: e.target.value })}
                      className="bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px]">
                      {ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <button type="button" onClick={() => saveReferences(references.filter((r) => r.id !== ref.id))}
                      aria-label="Remove reference" title="Remove reference"
                      className="ml-auto min-h-[32px] min-w-[32px] inline-flex items-center justify-center text-port-error">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <label htmlFor={idFor(`label-${ref.id}`)} className="sr-only">Reference label</label>
                  <input id={idFor(`label-${ref.id}`)} defaultValue={ref.label || ''} maxLength={120}
                    placeholder="Label (e.g. lead singer)"
                    onBlur={(e) => { if (e.target.value !== (ref.label || '')) updateRef(ref.id, { label: e.target.value }); }}
                    className="w-full bg-port-bg border border-port-border rounded px-1 py-0.5 text-[11px]" />
                  <label className="flex items-center gap-1 text-[11px]">
                    <input type="checkbox" checked={!!ref.condition}
                      disabled={!ref.condition && flagged >= MAX_CONDITIONING_REFERENCES}
                      onChange={(e) => updateRef(ref.id, { condition: e.target.checked })} />
                    Condition frames
                  </label>
                </div>
              </li>
            ))}
          </ul>
          {flagged > 0 && (
            <p className="text-[11px] text-port-text-muted">
              Conditioning needs an image backend that accepts reference images (local FLUX.2 or Qwen Image 2.1, or a cloud image CLI); others refuse the render and say so. At most {MAX_CONDITIONING_REFERENCES} per frame.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <span className="text-xs text-port-text-muted">Palette</span>
          <div className="flex flex-wrap items-center gap-1">
            {palette.map((c) => (
              <button key={c} type="button" onClick={() => onSave({ palette: palette.filter((p) => p !== c) })}
                aria-label={`Remove ${c} from palette`} title={`Remove ${c}`}
                className="w-7 h-7 rounded border border-port-border" style={{ backgroundColor: c }} />
            ))}
            <label htmlFor={idFor('color')} className="sr-only">Palette color</label>
            <input id={idFor('color')} type="color" value={color} onChange={(e) => setColor(e.target.value)}
              className="w-9 h-9 bg-transparent border border-port-border rounded" />
            <button type="button" disabled={palette.length >= MAX_PALETTE || palette.includes(color.toLowerCase())}
              onClick={() => onSave({ palette: [...palette, color.toLowerCase()] })}
              className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
              <Plus size={13} /> Add color
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <label htmlFor={idFor('camera')} className="block text-xs text-port-text-muted mb-1">Camera rules</label>
            <textarea id={idFor('camera')} rows={2} maxLength={2000}
              value={cameraRules.value} onChange={cameraRules.onChange} onBlur={cameraRules.onBlur}
              placeholder="Lenses, framing, movement — e.g. 35mm, locked-off wides, slow push-ins only"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label htmlFor={idFor('type')} className="block text-xs text-port-text-muted mb-1">Typography</label>
            <textarea id={idFor('type')} rows={2} maxLength={1000}
              value={typography.value} onChange={typography.onChange} onBlur={typography.onBlur}
              placeholder="On-screen text style — e.g. condensed sans, all caps, lower-third titles"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
          </div>
        </div>

        <MoodBoardReferenceStrip
          value={spec.moodBoardId || ''}
          onChange={(id) => onSave({ moodBoardId: id || null })}
          newBoardName={project.name}
        />
      </div>
    </details>
  );
}
