import { Plus, Trash2, UserRound } from 'lucide-react';
import { newFormId, formAgeField, formAgeLabel } from '../../lib/catalogForms';
import { BIBLE_LIMITS } from '../../lib/bibleLimits';
import { formatHeight, typicalHeightCm } from '../../../../server/lib/characterHeight.js';

const { FORM_LABEL_MAX: LABEL_MAX, FORM_AGE_MAX: AGE_MAX, FORM_DESCRIPTION_MAX: DESCRIPTION_MAX, FORM_HEIGHT_MAX: HEIGHT_MAX, FORMS_PER_ENTRY_MAX: FORMS_MAX } = BIBLE_LIMITS;

const inputClass = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent';
const labelClass = 'block text-xs uppercase tracking-wider text-gray-500 mb-1';

const PLACEHOLDERS = {
  character: { label: 'Age 7', age: '7', description: 'Gap-toothed, oversized yellow raincoat, scabbed knees' },
  place: { label: 'Abandoned, 2040', age: '2040', description: 'Boarded windows, ivy over the sign, cracked lot' },
  object: { label: 'Brand new', age: '1986', description: 'Glossy red paint, chrome still bright, tags attached' },
};

// The record's own fields are its canonical present-story form; `payload.forms`
// holds alternate ages, eras and looks/styles. Edits are part of the profile
// draft and persist with Save.
export default function CatalogFormsEditor({ type, payload, onChange }) {
  const forms = Array.isArray(payload.forms) ? payload.forms : [];
  const ageField = formAgeField(type);
  const ageLabel = formAgeLabel(type);
  const canonicalAge = ageField && typeof payload[ageField] === 'string' ? payload[ageField].trim() : '';
  const placeholder = PLACEHOLDERS[type] || PLACEHOLDERS.object;

  const setForms = (next) => onChange('forms', next);
  const update = (id, patch) => setForms(forms.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  return (
    <section aria-labelledby="catalog-forms-heading" className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 id="catalog-forms-heading" className="text-sm font-semibold text-white flex items-center gap-1.5">
          <UserRound size={14} aria-hidden="true" /> Ages &amp; looks
        </h2>
        <button type="button" disabled={forms.length >= FORMS_MAX}
          onClick={() => setForms([...forms, { id: newFormId(), label: '', age: '', description: '' }])}
          className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 py-1.5 rounded border border-port-border text-xs text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed">
          <Plus size={12} aria-hidden="true" /> Add age or look
        </button>
      </div>

      <div className="rounded border border-port-accent/40 bg-port-accent/5 px-3 py-2 text-sm">
        <span className="text-white font-medium">Canonical</span>
        <span className="text-gray-400"> · present story</span>
        {canonicalAge && <span className="text-gray-300"> · {ageLabel} {canonicalAge}</span>}
        <p className="text-xs text-gray-500 mt-0.5">The profile above. Other ages and looks below render their own sheets and tag their own references.</p>
      </div>

      {forms.length > 0 && (
        <ul className="space-y-3">
          {forms.map((form, index) => {
            const base = `catalog-form-${form.id || index}`;
            return (
              <li key={form.id || index} className="rounded border border-port-border bg-port-bg/40 p-3 space-y-2">
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] gap-2 items-end">
                  <div className="min-w-0">
                    <label htmlFor={`${base}-label`} className={labelClass}>Name</label>
                    <input id={`${base}-label`} type="text" value={form.label || ''} maxLength={LABEL_MAX}
                      onChange={(e) => update(form.id, { label: e.target.value })} placeholder={placeholder.label} className={inputClass} />
                  </div>
                  <div>
                    <label htmlFor={`${base}-age`} className={labelClass}>{ageLabel}</label>
                    <input id={`${base}-age`} type="text" value={form.age || ''} maxLength={AGE_MAX}
                      onChange={(e) => update(form.id, { age: e.target.value })} placeholder={placeholder.age} className={inputClass} />
                  </div>
                  <button type="button" onClick={() => setForms(forms.filter((f) => f.id !== form.id))}
                    aria-label={`Remove ${form.label || 'this age or look'}`} title="Remove"
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center min-w-[40px] min-h-[40px] rounded border border-port-border text-gray-400 hover:text-port-error">
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {!form.label?.trim() && <p className="text-xs text-port-warning">Name it, or Save drops it.</p>}
                {type === 'character' && (
                  <div>
                    <label htmlFor={`${base}-height`} className={labelClass}>Height</label>
                    <input id={`${base}-height`} type="text" value={form.height || ''} maxLength={HEIGHT_MAX}
                      onChange={(e) => update(form.id, { height: e.target.value })}
                      placeholder={typicalHeightCm(form.age) ? `${formatHeight(typicalHeightCm(form.age))}, typical at this age` : '5 ft 6 in (168 cm)'}
                      className={inputClass} />
                    <p className="mt-1 text-xs text-gray-500">Keeps this age to scale beside cars, doors and adults in a scene. Blank uses the typical height for a child’s age.</p>
                  </div>
                )}
                <div>
                  <label htmlFor={`${base}-description`} className={labelClass}>{type === 'character' ? 'Hair, clothing & appearance' : 'How it looks'}</label>
                  <textarea id={`${base}-description`} value={form.description || ''} maxLength={DESCRIPTION_MAX} rows={2}
                    onChange={(e) => update(form.id, { description: e.target.value })} placeholder={placeholder.description}
                    className={`${inputClass} resize-y`} />
                  {type === 'character' && <p className="mt-1 text-xs text-gray-500">Describe this age’s haircut, clothing and proportions. This replaces the canonical appearance and outfits for its renders; shared facial identity stays consistent.</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
