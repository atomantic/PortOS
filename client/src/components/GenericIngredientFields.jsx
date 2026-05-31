/**
 * GenericIngredientFields — the detail/edit renderer for USER-DEFINED catalog
 * ingredient types. System types (character/place/object/idea/scene/concept)
 * keep their hand-built editor sections in CatalogIngredient.jsx; a user type
 * has no per-type React file, so this generic renderer maps each declared field
 * `{ key, label, widget, maxLength? }` to a widget and reads/writes
 * `payload[key]` through `onChange(key, value)`.
 *
 * Widget kinds (derived from the server field `kind` by
 * `normalizeUserTypeForClient`):
 *   text     — single-line <input>            (server kind 'string')
 *   textarea — multi-line <textarea>          (server kind 'longtext')
 *   tags     — tag chip input (reuses TagPicker)         (server kind 'tags')
 *   ref      — catalog-ingredient id picker (IngredientPicker-backed) ('ref')
 *
 * Every field has an htmlFor/id pairing for screen-reader + click-to-focus.
 */

import { useState } from 'react';
import { Link2, X } from 'lucide-react';
import TagPicker from './TagPicker';
import IngredientPicker from './IngredientPicker';

const sharedInput = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent';

// A single `ref` field — stores a catalog ingredient id in payload[key]. Opens
// the shared IngredientPicker modal to choose the target.
function RefField({ fieldKey, label, value, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputId = `ingredient-${fieldKey}`;
  return (
    <div>
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="text"
          readOnly
          value={value || ''}
          placeholder="No ingredient linked"
          onClick={() => setPickerOpen(true)}
          className={`${sharedInput} cursor-pointer font-mono`}
        />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="inline-flex items-center gap-1 px-3 py-2 rounded border border-port-border text-gray-300 hover:text-white text-sm whitespace-nowrap"
        >
          <Link2 size={14} aria-hidden="true" /> {value ? 'Change' : 'Link'}
        </button>
        {value ? (
          <button
            type="button"
            onClick={() => onChange(fieldKey, '')}
            aria-label={`Clear ${label}`}
            className="inline-flex items-center px-2 py-2 rounded border border-port-border text-gray-400 hover:text-port-error"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <IngredientPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ing) => { onChange(fieldKey, ing?.id || ''); setPickerOpen(false); }}
      />
    </div>
  );
}

// One generic field, dispatched by widget kind.
function GenericField({ field, payload, onChange }) {
  const { key, label, widget, maxLength } = field;
  const inputId = `ingredient-${key}`;
  const value = payload?.[key];

  if (widget === 'tags') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div>
        <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
        <TagPicker id={inputId} value={arr} onChange={(next) => onChange(key, next)} placeholder="Add a value…" />
      </div>
    );
  }
  if (widget === 'ref') {
    return <RefField fieldKey={key} label={label} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
  }
  if (widget === 'textarea') {
    return (
      <div>
        <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
        <textarea
          id={inputId}
          rows={3}
          maxLength={maxLength}
          value={value ?? ''}
          onChange={(e) => onChange(key, e.target.value)}
          className={sharedInput}
        />
      </div>
    );
  }
  // default: 'text'
  return (
    <div>
      <label htmlFor={inputId} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        id={inputId}
        type="text"
        maxLength={maxLength}
        value={value ?? ''}
        onChange={(e) => onChange(key, e.target.value)}
        className={sharedInput}
      />
    </div>
  );
}

/**
 * Render the generic editable fields for a user-defined type.
 *   fields   — the type's `editorFields` ({ key, label, widget, maxLength? }).
 *   payload  — the ingredient payload object.
 *   onChange — (key, value) => void, writes payload[key].
 */
export default function GenericIngredientFields({ fields = [], payload = {}, onChange }) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return <p className="text-sm text-gray-500">This type has no fields yet — add some in Settings → Catalog.</p>;
  }
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <GenericField key={field.key} field={field} payload={payload} onChange={onChange} />
      ))}
    </div>
  );
}
