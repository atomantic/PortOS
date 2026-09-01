import { forwardRef } from 'react';
import useAutoSizeTextarea from '../../hooks/useAutoSizeTextarea';

/**
 * Controlled <textarea> that auto-grows to fit its content (no internal scroll,
 * no hand-resize). Pass a `min-h-*` class for the empty/short floor; the hook
 * sets the inline height to the content height above that. Forwards every other
 * textarea prop (value, onChange, onBlur, disabled, placeholder, aria-label…).
 */
const AutoSizeTextarea = forwardRef(function AutoSizeTextarea(
  { value, onChange, className = '', ...rest },
  forwardedRef
) {
  const [ref, resize] = useAutoSizeTextarea(value, forwardedRef);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => { onChange?.(e); resize(); }}
      className={`resize-none overflow-hidden break-words ${className}`}
      {...rest}
    />
  );
});

export default AutoSizeTextarea;
