/**
 * Inspector fields for the layered video timeline editor.
 *
 * Every numeric field declares its bounds ONCE: `NumberField` puts them on the
 * `<input>` and clamps the committed value with the same pair, so an input
 * whose `max` and clamp disagree isn't expressible.
 */

import { memo } from 'react';
import { Trash2 } from 'lucide-react';
import useFieldDraft from '../../hooks/useFieldDraft';
import { clamp } from '../../utils/formatters';
import { MAX_FADE_SEC } from '../../lib/videoTimelineModel';

/**
 * Commit-on-blur numeric input. The draft buffer is what lets the user type
 * "0." — committing per keystroke would round-trip each stroke through the
 * clamp and make that impossible.
 */
export const NumberField = memo(function NumberField({ id, label, value, step = 0.05, min = 0, max, hint, onCommit }) {
  const draft = useFieldDraft(Number.isFinite(value) ? Number(value).toFixed(2) : '', (next) => {
    // An emptied or non-numeric field is a discard, not a commit of zero:
    // useFieldDraft clears its buffer either way, so the input snaps back to
    // the persisted value instead of silently writing the clamped minimum.
    if (String(next).trim() === '') return;
    const n = Number(next);
    if (Number.isFinite(n)) onCommit(clamp(n, min, max ?? Infinity));
  });
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="block text-xs text-gray-400">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft.value}
        onChange={draft.onChange}
        onBlur={draft.onBlur}
        // The hint is described-by rather than nested in the label, or it
        // would be read as part of the field's name on every focus.
        aria-describedby={hintId}
        className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
      />
      {hint && <span id={hintId} className="block mt-0.5 text-[10px] text-gray-500">{hint}</span>}
    </div>
  );
});

/**
 * The fade pair every lane entry carries, bounded by its own duration AND by
 * the server's absolute fade cap — an entry longer than 30s would otherwise
 * let the user type a fade the save rejects with a 400, leaving the editor
 * unsavable until they guessed the real limit.
 */
export const FadeFields = memo(function FadeFields({ idPrefix, entry, duration, onCommit }) {
  const max = Math.min(Math.max(0, duration), MAX_FADE_SEC);
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField
        id={`${idPrefix}-fade-in`} label="Fade in (s)" value={entry.fadeInSec ?? 0} max={max}
        onCommit={(n) => onCommit({ fadeInSec: n })}
      />
      <NumberField
        id={`${idPrefix}-fade-out`} label="Fade out (s)" value={entry.fadeOutSec ?? 0} max={max}
        onCommit={(n) => onCommit({ fadeOutSec: n })}
      />
    </div>
  );
});

export const RemoveButton = memo(function RemoveButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
    >
      <Trash2 className="w-3 h-3" /> {label}
    </button>
  );
});
