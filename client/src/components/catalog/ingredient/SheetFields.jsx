import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { BIBLE_LIMITS } from '../../../lib/bibleLimits';
import { formatCount } from '../../../utils/formatters';

// One editable scalar field in the character sheet. `kind` is 'text' (single
// line) or 'textarea' (multi-line). Edits write straight through to the shared
// payload via `onChange(key, value)` — the same durable catalog row the
// Universe Builder canon surface edits.
export function SheetField({ fieldKey, label, kind, value, onChange, videoDescriptionLimit }) {
  const inputId = `ingredient-${fieldKey}`;
  const showVideoCount = fieldKey === 'description' && videoDescriptionLimit;
  const shared = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent';
  return (
    <div>
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      {['intExt', 'timeOfDay'].includes(kind)
        ? <select id={inputId} value={value || ''} onChange={(event) => onChange(fieldKey, event.target.value || null)} className={shared}>
            <option value="">Not specified</option>
            {(kind === 'intExt' ? ['INT', 'EXT'] : ['dawn', 'day', 'dusk', 'night']).map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        : kind === 'textarea'
        ? <textarea id={inputId} aria-describedby={showVideoCount ? `${inputId}-video-count` : undefined} rows={3} value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={shared} />
        : <input id={inputId} type="text" value={value} onChange={(e) => onChange(fieldKey, e.target.value)} className={shared}
            {...(kind === 'size' ? { maxLength: BIBLE_LIMITS.SIZE_MAX, placeholder: 'fence 4 ft tall · 5 ft 8 in long, 3 ft 4 in high', 'aria-describedby': `${inputId}-hint` } : {})} />}
      {kind === 'size' && <p id={`${inputId}-hint`} className="mt-1 text-xs text-gray-500">Keeps it to scale beside people in renders and states it on its sheet. For a place, size its key features (fences, signs, doors).</p>}
      {showVideoCount && <p id={`${inputId}-video-count`} className={`text-xs ${value.length > videoDescriptionLimit ? 'text-port-error' : 'text-port-text-muted'}`}>
        {formatCount(value.length)} / {formatCount(videoDescriptionLimit)} characters for linked music videos
      </p>}
    </div>
  );
}

// One collapsible "sheet section" — a labeled group of scalar fields. Open by
// default; collapsing keeps the long character sheet manageable above the fold.
export function SheetSection({ title, fields, payload, onChange, videoDescriptionLimit }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 bg-port-bg/60 hover:bg-port-bg text-left">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">{title}</span>
        <ChevronDown size={14} aria-hidden="true"
          className={`text-gray-500 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="p-3 space-y-3">
          {fields.map(([key, label, kind]) => (
            <SheetField key={key} fieldKey={key} label={label} kind={kind}
              value={payload[key] ?? ''} onChange={onChange} videoDescriptionLimit={videoDescriptionLimit} />
          ))}
        </div>
      )}
    </div>
  );
}
