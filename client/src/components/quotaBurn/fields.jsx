/**
 * Shared field primitives for the Quota Burn config surface.
 *
 * The three components here (`FamilyCard`, `JobRow`, `JobParamField`) all render
 * the same dark label+control pair. Keeping the class string and the number
 * field in one place means a styling change is one edit rather than four —
 * before this, the identical Tailwind string was declared or inlined at four
 * sites and had already started to drift.
 */

import { useState } from 'react';

export const inputClass = 'w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs';

/**
 * A labeled number input with an optional hint line beneath it.
 *
 * Holds a local draft string so the box can be EMPTY mid-edit without
 * committing a value. `Number('') === 0`, and 0 is below the server minimum for
 * `checkIntervalMinutes` (5) and `maxDispatchesPerWindow` (1) — so a user who
 * clears the box to retype it, and pauses past the save debounce, would 400 the
 * request and take every other edit coalesced into that body down with it.
 * Committing only on a parseable number avoids the whole class. The draft is
 * released on blur so the field snaps back to whatever the server stored.
 */
export function NumberField({ id, label, value, onChange, min, max, hint }) {
  const [draft, setDraft] = useState(null);
  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        className={inputClass}
        value={draft ?? value}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw !== '' && Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
        onBlur={() => setDraft(null)}
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
