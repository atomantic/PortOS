import { forwardRef, useState } from 'react';
import AutoSizeTextarea from './AutoSizeTextarea.jsx';

/**
 * An auto-growing textarea that keeps what is being typed in its own state and hands it
 * to `onCommit(text)` on blur, so a large parent (a shot card inside the whole project
 * page) does not re-render on every keystroke. `onBlur` runs after the commit with the
 * original event. While focused the draft wins over `value`; after blur `value` shows
 * again, which the parent has updated from `onCommit`.
 */
const BlurCommitTextarea = forwardRef(function BlurCommitTextarea({ value, onCommit, onBlur, ...rest }, ref) {
  const [draft, setDraft] = useState(null);
  return (
    <AutoSizeTextarea ref={ref} {...rest} value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        if (draft !== null) { onCommit?.(draft); setDraft(null); }
        onBlur?.(e);
      }} />
  );
});

export default BlurCommitTextarea;
