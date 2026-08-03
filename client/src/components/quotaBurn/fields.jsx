/**
 * Shared field primitives for the Quota Burn config surface.
 *
 * The three components here (`FamilyCard`, `JobRow`, `JobParamField`) all render
 * the same dark label+control pair. Keeping the class string and the number
 * field in one place means a styling change is one edit rather than four —
 * before this, the identical Tailwind string was declared or inlined at four
 * sites and had already started to drift.
 */

export const inputClass = 'w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs';

/** A labeled number input with an optional hint line beneath it. */
export function NumberField({ id, label, value, onChange, min, max, hint }) {
  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="block mt-1 text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}

/** A labeled text input. `value` is always controlled; `null` renders as empty. */
export function TextField({ id, label, value, onChange, placeholder }) {
  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <input
        id={id}
        className={inputClass}
        value={value || ''}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  );
}
