import { useState } from 'react';
import { Plus, Palette } from 'lucide-react';
import useFieldDraft from '../../hooks/useFieldDraft.js';

const MAX_PALETTE = 12;

/**
 * The project's reusable visual specification (#8965): a palette, typography
 * and camera rules, appended to every generated prompt. The reference images
 * (with their role, use and "Condition frames" toggle) live in the one Look
 * references list (LookReferencesPanel, #10223).
 *
 * `onSave(patch)` persists a partial `visualSpec` (the server merges it per
 * sub-field); `palette` is always sent whole. Keyed by the
 * project id at the call site, so a draft never carries across projects.
 */
export default function VisualSpecPanel({ project, onSave }) {
  const spec = project.visualSpec || {};
  const palette = spec.palette || [];
  const [color, setColor] = useState('#336699');
  const typography = useFieldDraft(spec.typography, (v) => onSave({ typography: v }));
  const cameraRules = useFieldDraft(spec.cameraRules, (v) => onSave({ cameraRules: v }));
  const idFor = (suffix) => `mv-spec-${project.id}-${suffix}`;

  return (
    <details className="mt-2 rounded border border-port-border bg-port-bg/40 p-2 group">
      <summary className="cursor-pointer text-xs text-port-text-muted select-none min-h-[44px] sm:min-h-[32px] flex items-center gap-2">
        <Palette size={13} />
        <span>Visual spec</span>
        {palette.length > 0 && (
          <span className="flex gap-0.5" aria-hidden="true">
            {palette.map((c) => <span key={c} className="inline-block w-3 h-3 rounded-sm border border-port-border" style={{ backgroundColor: c }} />)}
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-3">
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
              className="w-9 h-9 bg-transparent border border-port-border rounded min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0" />
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


      </div>
    </details>
  );
}
