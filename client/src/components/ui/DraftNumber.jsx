import { useState } from 'react';

/**
 * Field props for a number input that shows the text being typed and commits the clamped value as it changes.
 *
 * Clamping a controlled field on every keystroke rewrites it mid-number: with `min={10}`, typing
 * "25" becomes "105", and a leading "-" or a cleared box snaps to the fallback. Here the box keeps
 * the typed text until blur. A blank box commits nothing unless `blankable`, which commits `undefined`.
 *
 * A `FormField` goes inside the render function, around the input it labels.
 * The caller renders the `<input>` so its accessible name stays at the call site:
 *   <DraftNumber value={n} min={1} onCommit={setN}>{(field) => <input type="number" id="n" {...field} />}</DraftNumber>
 */
export default function DraftNumber({ value, onCommit, min, max, integer = false, blankable = false, onBlur, children }) {
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
  return children({
    min,
    max,
    value: draft ?? value ?? '',
    onChange: (event) => change(event.target.value),
    onBlur: (event) => { setDraft(null); onBlur?.(event); },
  });
}
