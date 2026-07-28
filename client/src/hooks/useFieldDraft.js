// Local draft buffer that commits on blur. Bible-editor inputs buffer
// keystrokes locally so a textarea keystroke doesn't fire a universe-wide
// round-trip per character. `onChange` accepts either a synthetic event or
// a raw string. `onBlur` is a no-op when the draft equals the persisted
// value, so a focus-without-edit doesn't fire a redundant PATCH. Persisted
// `null`/`undefined` coerces to `''` so the input doesn't flip between
// controlled and uncontrolled.
import { useState } from 'react';

export default function useFieldDraft(persisted, onCommit) {
  const [draft, setDraft] = useState(undefined);
  const persistedStr = persisted == null ? '' : String(persisted);
  const value = draft !== undefined ? draft : persistedStr;

  const onChange = (e) => {
    const next = e && e.target ? e.target.value : e;
    setDraft(next);
  };

  const onBlur = () => {
    if (draft === undefined) return;
    if (draft === persistedStr) { setDraft(undefined); return; }
    onCommit(draft);
    setDraft(undefined);
  };

  // Discards a pending, uncommitted edit without firing onCommit — for a caller
  // whose `persisted` identity can change out from under a still-focused input
  // (e.g. the user navigates to a different record before blurring), so the
  // stale draft can't be blurred onto the new record on the next unrelated blur.
  const reset = () => setDraft(undefined);

  return { value, onChange, onBlur, reset };
}
