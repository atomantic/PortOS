import { useEffect, useRef, useState } from 'react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';

/**
 * A text field that saves on blur (and on Enter for a single line), so typing
 * never fires a request per keystroke. It follows `value` from the server
 * until the user starts editing, then keeps their draft until it commits.
 * `maxLength` is shown as a count and refused at the input — text is never cut.
 */
export default function CommitField({
  id, value, onCommit, multiline = false, maxLength, placeholder, className = '', ariaLabel, minHeightClass = 'min-h-[2.5rem]',
}) {
  const [draft, setDraft] = useState(value ?? '');
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDraft(value ?? '');
  }, [value]);

  const commit = () => {
    editingRef.current = false;
    if (draft !== (value ?? '')) onCommit(draft);
  };

  const shared = {
    id,
    value: draft,
    placeholder,
    maxLength,
    onFocus: () => { editingRef.current = true; },
    onChange: (event) => { editingRef.current = true; setDraft(event.target.value); },
    onBlur: commit,
    className: `w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none ${className}`,
  };
  const nearLimit = maxLength && draft.length > maxLength * 0.9;

  return (
    <>
      {multiline ? (
        <AutoSizeTextarea {...shared} aria-label={ariaLabel} rows={2} className={`${shared.className} ${minHeightClass}`} />
      ) : (
        <input
          type="text"
          {...shared}
          aria-label={ariaLabel}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        />
      )}
      {nearLimit ? <p className="mt-0.5 text-[11px] text-port-warning tabular-nums">{draft.length} / {maxLength}</p> : null}
    </>
  );
}
