import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import FormField from '../ui/FormField';
import ToggleSwitch from '../ToggleSwitch';

/**
 * A job's own configuration form — the two halves of it.
 *
 * `JobFormFieldsEditor` edits the DEFINITIONS (what inputs this job has);
 * `JobFormValueInputs` renders those definitions as real inputs and edits the
 * VALUES. They are separate components because they are separate decisions at
 * different tempos: the shape of a job is designed once, while its values are
 * re-aimed before a run. `server/lib/jobFormFields.js` is the server half — it
 * validates both and projects the values into the agent's prompt.
 */

const JOB_FORM_FIELD_TYPE_OPTIONS = [
  { value: 'text', label: 'Text (single line)' },
  { value: 'textarea', label: 'Text (multi-line)' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Choice' },
  { value: 'checkbox', label: 'Yes / no' },
];

/** Whether a field's value comes from a declared option list. */
const isChoiceField = (type) => type === 'select';

const inputClass = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm';

/**
 * A blank definition. The generated key is the first `field_N` not already in
 * use rather than one derived from the length — add, delete the first, add again
 * and a length-derived name collides with a key that is still there, which the
 * server rejects only at save time.
 */
function emptyField(fields) {
  const taken = new Set(fields.map((field) => field.key));
  let n = fields.length + 1;
  while (taken.has(`field_${n}`)) n += 1;
  return { key: `field_${n}`, label: '', type: 'text' };
}

/** Parse the textarea form of an option list: one `value` or `value|Label` per line. */
function parseOptions(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split('|');
      const label = rest.join('|').trim();
      return label ? { value: value.trim(), label } : { value: value.trim() };
    })
    .filter((option) => option.value);
}

function serializeOptions(options) {
  return (options || []).map(({ value, label }) => (label ? `${value}|${label}` : value)).join('\n');
}

/**
 * The choice list, edited as text.
 *
 * It holds its own raw string because parse→serialize is deliberately lossy —
 * blank lines are dropped, whitespace trimmed. Feeding the re-serialized value
 * back into the textarea would erase each newline as it is typed (after `a\n`
 * the parse yields one option and the serialize yields `a`), making a
 * multi-option list impossible to enter. So: raw text drives the textarea, the
 * parsed form is what leaves the component, and an external change to the field
 * (a reorder, a type switch) re-seeds the raw text via `key`.
 */
function OptionsEditor({ options, onChange }) {
  const [text, setText] = useState(() => serializeOptions(options));
  return (
    <FormField label="Choices" hint="One per line. Use value|Label to show something friendlier than the stored value." compact>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseOptions(e.target.value));
        }}
        className={`${inputClass} font-mono h-20`}
      />
    </FormField>
  );
}

/**
 * The value a field should start at when it has never been set: `false` for a
 * checkbox (a yes/no question always has an answer), `''` for everything else
 * (which the server reads as "not supplied" and omits from the prompt).
 */
function blankValue(field) {
  return field.type === 'checkbox' ? false : '';
}

/** Declared fields whose value is required but missing — the save/trigger gate. */
export function missingRequiredJobFormFields(fields, values) {
  return (fields || []).filter((field) => {
    if (!field?.required) return false;
    // A checkbox answers itself: `false` is an answer, so it can never be missing.
    if (field.type === 'checkbox') return false;
    const value = values?.[field.key];
    return value == null || String(value).trim() === '';
  });
}

/** Edit the definitions: what inputs this job exposes. */
export function JobFormFieldsEditor({ fields = [], onChange }) {
  const update = (index, patch) => {
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  };

  const changeType = (index, type) => {
    const field = fields[index];
    const patch = { type };
    // Options only belong to option-typed fields, and the server rejects them
    // on any other type — so drop them on the way out and seed one on the way in.
    if (!isChoiceField(type)) patch.options = undefined;
    else if (!field.options?.length) patch.options = [{ value: 'option-1' }];
    update(index, patch);
  };

  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div>
      <span className="text-sm text-gray-400 block mb-1">Configuration fields</span>
      <p className="text-xs text-gray-500 mb-2">
        Inputs this task exposes. Whatever they are set to is appended to the agent&apos;s prompt as run configuration, so one prompt can be re-aimed without rewriting it.
      </p>

      <div className="space-y-2">
        {fields.map((field, index) => (
          <div key={index} className="bg-port-bg/60 border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <FormField label="Label" compact>
                  <input
                    type="text"
                    value={field.label || ''}
                    placeholder="What the agent reads, e.g. Topic"
                    onChange={(e) => update(index, { label: e.target.value })}
                    className={inputClass}
                  />
                </FormField>
                <FormField label="Key" compact>
                  <input
                    type="text"
                    value={field.key || ''}
                    placeholder="topic"
                    onChange={(e) => update(index, { key: e.target.value })}
                    className={inputClass}
                  />
                </FormField>
              </div>
              <div className="flex flex-col pt-5">
                <button
                  type="button"
                  aria-label={`Move ${field.label || field.key || 'field'} up`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${field.label || field.key || 'field'} down`}
                  onClick={() => move(index, 1)}
                  disabled={index === fields.length - 1}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <FormField label="Type" compact>
                <select
                  value={field.type || 'text'}
                  onChange={(e) => changeType(index, e.target.value)}
                  className={inputClass}
                >
                  {JOB_FORM_FIELD_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Placeholder" compact>
                <input
                  type="text"
                  value={field.placeholder || ''}
                  onChange={(e) => update(index, { placeholder: e.target.value })}
                  className={inputClass}
                />
              </FormField>
            </div>

            {isChoiceField(field.type) && (
              <OptionsEditor
                key={`${index}-${field.type}`}
                options={field.options}
                onChange={(options) => update(index, { options })}
              />
            )}

            <FormField label="Hint" hint="Shown under the input. Explains the field to you, and is not sent to the agent." compact>
              <input
                type="text"
                value={field.description || ''}
                onChange={(e) => update(index, { description: e.target.value })}
                className={inputClass}
              />
            </FormField>

            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-pressed={!!field.required}
                aria-label={`Required: ${field.required ? 'on' : 'off'}`}
                onClick={() => update(index, { required: !field.required })}
                className="flex items-center gap-2 min-h-[44px] text-sm text-gray-400 hover:text-white"
              >
                <ToggleSwitch enabled={!!field.required} decorative />
                Required
              </button>
              <button
                type="button"
                aria-label={`Remove ${field.label || field.key || 'field'}`}
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-red-400"
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onChange([...fields, emptyField(fields)])}
        className="mt-2 flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
      >
        <Plus size={16} /> Add field
      </button>
    </div>
  );
}

/**
 * Fill in the declared fields. Renders nothing when the job declares none.
 * `title` may be null for a host that labels the section itself (the card's
 * inline ad-hoc run panel).
 */
export function JobFormValueInputs({ fields = [], values = {}, onChange, title = 'Run configuration' }) {
  if (!fields.length) return null;

  const set = (key, value) => onChange({ ...values, [key]: value });

  return (
    <div>
      {title && <span className="text-sm text-gray-400 block mb-2">{title}</span>}
      <div className="space-y-2">
        {fields.map((field, index) => {
          // `??` rather than `||`: a stored `false` or `0` is a real value and
          // must not fall through to the blank default.
          const value = values?.[field.key] ?? blankValue(field);
          const label = `${field.label || field.key}${field.required ? ' *' : ''}`;

          if (field.type === 'checkbox') {
            return (
              <div key={`${field.key}-${index}`}>
                <button
                  type="button"
                  aria-pressed={!!value}
                  aria-label={`${field.label || field.key}: ${value ? 'on' : 'off'}`}
                  onClick={() => set(field.key, !value)}
                  className="w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left hover:bg-port-card/30"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-sm text-white block">{label}</span>
                    {field.description && <span className="text-xs text-gray-500 block">{field.description}</span>}
                  </span>
                  <ToggleSwitch enabled={!!value} decorative />
                </button>
              </div>
            );
          }

          return (
            <FormField key={`${field.key}-${index}`} label={label} hint={field.description || undefined}>
              {field.type === 'textarea' ? (
                <textarea
                  value={value}
                  placeholder={field.placeholder || ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  className={`${inputClass} h-24`}
                />
              ) : field.type === 'select' ? (
                <select value={value} onChange={(e) => set(field.key, e.target.value)} className={inputClass}>
                  <option value="">—</option>
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>{option.label || option.value}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={value}
                  placeholder={field.placeholder || ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  className={inputClass}
                />
              )}
            </FormField>
          );
        })}
      </div>
    </div>
  );
}
