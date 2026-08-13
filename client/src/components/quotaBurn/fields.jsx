/**
 * Shared field primitives for the Quota Burn config surface.
 *
 * `FamilyCard`, `JobRow`, `JobParamField` and `PresetPicker` all render the same
 * dark label+control pair. Keeping the class string and the number field in one
 * place means a styling change is one edit rather than four — before this, the
 * identical Tailwind string was declared or inlined at four sites and had
 * already started to drift.
 */

import { useState } from 'react';

export const inputClass = 'w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs';

/**
 * Why a draft is invalid, or `null` when it is a committable number.
 *
 * Empty, non-numeric and out-of-range all get the SAME range sentence: the
 * useful thing to tell someone who just cleared the box is what the field will
 * accept, not that "" is not a number.
 */
export function numberFieldError(raw, { min, max } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const parsed = text === '' || text === null || text === undefined ? NaN : Number(text);
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  const inRange = Number.isFinite(parsed) && (!hasMin || parsed >= min) && (!hasMax || parsed <= max);
  if (inRange) return null;
  if (hasMin && hasMax) return `Must be between ${min} and ${max}`;
  if (hasMin) return `Must be ${min} or more`;
  if (hasMax) return `Must be ${max} or less`;
  return 'Must be a number';
}

/**
 * A labeled number input with an optional hint line beneath it.
 *
 * Holds a local draft string so the box can be EMPTY mid-edit without
 * committing a value. `Number('') === 0`, and 0 is not an accepted value for
 * `checkIntervalMinutes` (minimum 5) or `maxDispatchesPerWindow` (1–50, or the
 * -1 "unlimited" sentinel) — so a user who clears the box to retype it, and
 * pauses past the save debounce, would 400 the request and take every other
 * edit coalesced into that body down with it.
 * Committing only on an in-range number avoids the whole class.
 *
 * The draft is released on blur ONLY when it committed. An empty or
 * out-of-range draft is kept on screen next to an inline error instead —
 * snapping silently back to the stored value reads as "my edit was eaten"
 * with nothing on screen explaining why.
 */
export function NumberField({ id, label, value, onChange, min, max, hint }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const errorId = `${id}-error`;
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
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (numberFieldError(raw, { min, max })) return;
          // Clear a prior error as soon as the draft is committable again —
          // waiting for blur would leave a stale complaint under a good value.
          setError(null);
          onChange(Number(raw));
        }}
        onBlur={() => {
          if (draft === null) return;
          const message = numberFieldError(draft, { min, max });
          setError(message);
          if (!message) setDraft(null);
        }}
      />
      {error && <span id={errorId} role="alert" className="block mt-1 text-[11px] text-red-400">{error}</span>}
      {hint && <span className="block mt-1 text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}
