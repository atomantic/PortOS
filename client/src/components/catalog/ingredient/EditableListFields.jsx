import { Plus, X } from 'lucide-react';

// Structured array-field editors (aliases / color palette / stats). Each field
// is declared on the type registry as `{ key, label, kind, itemMax, listMax }`
// and dispatched to the matching editor below. Edits write the WHOLE array back
// through `onChange(key, nextArray)` into the shared payload state, so the
// page's existing `handleSave` persists them — no new endpoint. The server's
// storyBible sanitizer re-caps/normalizes on save (it owns the durable shape);
// these editors mirror its caps so the add-button disables at the limit rather
// than silently dropping rows on save.
export default function EditableListFields({ fields, payload, onChange }) {
  return (
    <div className="space-y-4 pt-1">
      {fields.map((f) => {
        const value = Array.isArray(payload[f.key]) ? payload[f.key] : [];
        const set = (next) => onChange(f.key, next);
        if (f.kind === 'colorPalette') {
          return <ColorPaletteEditor key={f.key} field={f} value={value} onChange={set} />;
        }
        if (f.kind === 'kv') {
          return <StatListEditor key={f.key} field={f} value={value} onChange={set} />;
        }
        return <AliasListEditor key={f.key} field={f} value={value} onChange={set} />;
      })}
    </div>
  );
}

// Shared section header for the array editors. `atCap` toggles the add-button
// disabled state + a small "(max N)" hint so the cap is discoverable.
function ListEditorHeader({ label, count, listMax, onAdd, addLabel = 'Add' }) {
  const atCap = count >= listMax;
  return (
    <div className="flex items-center justify-between gap-2 mb-1.5">
      <span className="text-xs uppercase tracking-wider text-gray-500">
        {label} <span className="text-gray-600 normal-case tracking-normal">({count}/{listMax})</span>
      </span>
      <button type="button" onClick={onAdd} disabled={atCap}
        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40 disabled:cursor-not-allowed"
        title={atCap ? `Maximum ${listMax} reached` : addLabel}>
        <Plus size={12} aria-hidden="true" /> {addLabel}
      </button>
    </div>
  );
}

const listInput = 'px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs focus:outline-none focus:border-port-accent';

// String-array chips editor (e.g. aliases). Each row is a single-line input
// with a remove button; the add-button is disabled at `listMax`.
function AliasListEditor({ field, value, onChange }) {
  const { label, itemMax, listMax } = field;
  const items = value.map((v) => (typeof v === 'string' ? v : String(v ?? '')));
  const add = () => { if (items.length < listMax) onChange([...items, '']); };
  const update = (i, next) => onChange(items.map((v, idx) => (idx === i ? next : v)));
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <div>
      <ListEditorHeader label={label} count={items.length} listMax={listMax} onAdd={add} addLabel="Add alias" />
      {items.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((v, i) => {
            const inputId = `${field.key}-${i}`;
            return (
              <span key={i} className="inline-flex items-center gap-1">
                <label htmlFor={inputId} className="sr-only">{label} {i + 1}</label>
                <input id={inputId} type="text" value={v} maxLength={itemMax}
                  onChange={(e) => update(i, e.target.value)} className={`${listInput} w-40`} />
                <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Color-palette editor — rows of `{ name, hex, role }`. A native color swatch
// sits beside the hex text input so the user can pick OR type a value (the
// sanitizer tolerates non-hex names like "off-white", so the text input is the
// source of truth and the swatch is a convenience).
function ColorPaletteEditor({ field, value, onChange }) {
  const { label, listMax } = field;
  const rows = value.map((c) => (c && typeof c === 'object' ? c : {}));
  const add = () => { if (rows.length < listMax) onChange([...rows, { name: '', hex: '', role: '' }]); };
  const update = (i, key, next) => onChange(rows.map((c, idx) => (idx === i ? { ...c, [key]: next } : c)));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  // A native <input type=color> needs a 7-char #rrggbb; a blank/short/named
  // value falls back to a neutral swatch so the picker doesn't error.
  const swatchVal = (hex) => (/^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : '#888888');
  return (
    <div>
      <ListEditorHeader label={label} count={rows.length} listMax={listMax} onAdd={add} addLabel="Add color" />
      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5 flex-wrap">
              <label htmlFor={`${field.key}-hex-${i}`} className="sr-only">{label} {i + 1} hex</label>
              <input type="color" aria-label={`${label} ${i + 1} swatch`} value={swatchVal(c.hex)}
                onChange={(e) => update(i, 'hex', e.target.value)}
                className="w-7 h-7 rounded border border-port-border bg-port-bg p-0.5 cursor-pointer" />
              <input type="text" placeholder="name" value={c.name || ''} maxLength={80}
                aria-label={`${label} ${i + 1} name`}
                onChange={(e) => update(i, 'name', e.target.value)} className={`${listInput} w-32`} />
              <input id={`${field.key}-hex-${i}`} type="text" placeholder="#hex / value" value={c.hex || ''} maxLength={10}
                onChange={(e) => update(i, 'hex', e.target.value)} className={`${listInput} w-28 font-mono`} />
              <input type="text" placeholder="role (e.g. skin)" value={c.role || ''} maxLength={120}
                aria-label={`${label} ${i + 1} role`}
                onChange={(e) => update(i, 'role', e.target.value)} className={`${listInput} w-32`} />
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Key/value stat editor — rows of `{ label, value }`. NOTE the field shape: the
// storyBible sanitizer (`sanitizeStat`) stores `{ label, value }`, NOT
// `{ key, value }`. The prior read-only renderer read `s.key`, which silently
// rendered blank for every real stat — this editor + the durable shape now
// standardize on `.label`.
function StatListEditor({ field, value, onChange }) {
  const { label, itemMax, listMax } = field;
  const rows = value.map((s) => (s && typeof s === 'object' ? s : {}));
  const add = () => { if (rows.length < listMax) onChange([...rows, { label: '', value: '' }]); };
  const update = (i, key, next) => onChange(rows.map((s, idx) => (idx === i ? { ...s, [key]: next } : s)));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  return (
    <div>
      <ListEditorHeader label={label} count={rows.length} listMax={listMax} onAdd={add} addLabel="Add stat" />
      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-600">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5 flex-wrap">
              <label htmlFor={`${field.key}-label-${i}`} className="sr-only">{label} {i + 1} label</label>
              <input id={`${field.key}-label-${i}`} type="text" placeholder="label" value={s.label || ''} maxLength={80}
                onChange={(e) => update(i, 'label', e.target.value)} className={`${listInput} w-36`} />
              <label htmlFor={`${field.key}-value-${i}`} className="sr-only">{label} {i + 1} value</label>
              <input id={`${field.key}-value-${i}`} type="text" placeholder="value" value={s.value || ''} maxLength={itemMax}
                onChange={(e) => update(i, 'value', e.target.value)} className={`${listInput} w-40`} />
              <button type="button" onClick={() => remove(i)} aria-label={`Remove ${label} ${i + 1}`}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error"><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
