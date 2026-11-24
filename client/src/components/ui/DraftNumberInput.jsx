import { useState } from 'react';

/**
 * A number input that shows the text being typed and commits the clamped value as it changes.
 *
 * Clamping a controlled field on every keystroke rewrites it mid-number: with `min={10}`, typing
 * "25" becomes "105", and a leading "-" or a cleared box snaps to the fallback. Here the box keeps
 * the typed text until blur. A blank box commits nothing unless `blankable`, which commits `undefined`.
 */
export default function DraftNumberInput({ value, onCommit, min, max, integer = false, blankable = false, onBlur, ...props }) {
  const [draft, setDraft] = useState(null);
  const change = (text) => {
    setDraft(text);
    if (text === '') {
      if (blankable) onCommit(undefined);
      return;
    }
    const number = integer ? Math.trunc(Number(text)) : Number(text);
    if (!Number.isFinite(number)) return;
    onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number)));
  };
  return (
    <input
      {...props}
      type="number"
      min={min}
      max={max}
      value={draft ?? value ?? ''}
      onChange={(event) => change(event.target.value)}
      onBlur={(event) => { setDraft(null); onBlur?.(event); }}
    />
  );
}
