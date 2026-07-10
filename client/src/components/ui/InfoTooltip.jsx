import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';

// Accessible info/help tooltip. Renders a focusable <button> trigger with an
// Info icon; the help text is revealed on hover, keyboard focus, OR click/tap,
// and dismissed with Escape or a click/tap outside. This replaces CSS-only
// `group-hover` affordances on non-focusable icons, which keyboard and touch
// users can never reach.
//
// ARIA: the panel carries `role="tooltip"` and is linked to the trigger via
// `aria-describedby` while visible, so screen readers announce it; the button's
// `aria-expanded` reflects the click-latched open state. Pass `children` as the
// help text and `label` as the button's accessible name.
export default function InfoTooltip({
  children,
  label = 'More information',
  className = '',
  panelClassName = 'w-56',
  iconSize = 14,
  align = 'center',
}) {
  // `open` is click/tap-latched (survives blur until Escape or outside click);
  // `hovered` is the transient hover/focus reveal. Either makes the panel visible.
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef(null);
  const panelId = useId();
  const close = useCallback(() => {
    setOpen(false);
    setHovered(false);
  }, []);

  useClickOutside(wrapRef, open, () => setOpen(false));

  useEffect(() => {
    if (!open && !hovered) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hovered, close]);

  const visible = open || hovered;
  const alignClass = align === 'start'
    ? 'left-0'
    : align === 'end'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <div
      ref={wrapRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={visible ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="inline-flex items-center rounded text-gray-500 transition-colors hover:text-gray-300 focus:text-gray-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent"
      >
        <Info size={iconSize} aria-hidden="true" />
      </button>
      {visible && (
        <div
          id={panelId}
          role="tooltip"
          className={`absolute bottom-full ${alignClass} z-50 mb-1.5 rounded-lg border border-port-border bg-gray-800 px-3 py-2 text-xs text-gray-300 shadow-lg ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
