// Local draft buffer that commits on blur. Bible-editor inputs buffer
// keystrokes locally so a textarea keystroke doesn't fire a universe-wide
// round-trip per character. `onChange` accepts either a synthetic event or
// a raw string. `onBlur` is a no-op when the draft equals the persisted
// value, so a focus-without-edit doesn't fire a redundant PATCH. Persisted
// `null`/`undefined` coerces to `''` so the input doesn't flip between
// controlled and uncontrolled.
import { useRef, useState } from 'react';
import { useDraftCommitMode } from './useDraftCommitMode';

export default function useFieldDraft(persisted, onCommit) {
  const immediate = useDraftCommitMode() === 'change';
  const [draft, setDraft] = useState(undefined);
  const persistedStr = persisted == null ? '' : String(persisted);
  const previous = useRef(persistedStr);
  const localChange = useRef(false);
  // Preserve raw punctuation during the immediate parent echo, but let an
  // explicit reload/save normalization replace a focused field's old buffer.
  if (immediate && previous.current !== persistedStr) {
    previous.current = persistedStr;
    if (!localChange.current && draft !== undefined) setDraft(undefined);
  }
  localChange.current = false;
  const value = draft !== undefined ? draft : persistedStr;

  const onChange = (e) => {
    const next = e && e.target ? e.target.value : e;
    if (immediate) { localChange.current = true; setDraft(next); onCommit(next); return; }
    setDraft(next);
  };

  const onBlur = () => {
    if (immediate) { setDraft(undefined); return; }
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
