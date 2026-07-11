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
// `aria-describedby` while visible, so screen readers announce it. There is no
// `aria-expanded` — this follows the ARIA tooltip pattern (not a disclosure), so
// exposing an expanded state would misdescribe the widget and could drift out of
// sync with the hover/focus reveal. `visible` is the single source of truth for
// whether the panel shows; `pinned` only records that a click latched it open so
// it survives blur. Pass `children` as the help text and `label` as the button's
// accessible name.
export default function InfoTooltip({
  children,
  label = 'More information',
  className = '',
  panelClassName = 'w-56',
  iconSize = 14,
  align = 'center',
}) {
  // `pinned` = a click/tap latched it open (survives blur until Escape / outside
  // click / another click). `hovering` = the transient hover-or-focus reveal.
  // The panel is visible when either is true — one derived `visible` flag.
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const wrapRef = useRef(null);
  const panelId = useId();
  const visible = pinned || hovering;

  const close = useCallback(() => {
    setPinned(false);
    setHovering(false);
  }, []);

  // Drive outside-click dismissal off `visible`, not just `pinned`: on touch a
  // tap can synthesize a sticky hover (setting `hovering`) that some mobile
  // browsers never clear with a matching mouseleave, so gating on `pinned` alone
  // could strand the panel open on the very touch path this component targets.
  useClickOutside(wrapRef, visible, close);

  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, close]);

  const alignClass = align === 'start'
    ? 'left-0'
    : align === 'end'
      ? 'right-0'
      : 'left-1/2 -translate-x-1/2';

  return (
    <div
      ref={wrapRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={visible ? panelId : undefined}
        onClick={() => setPinned((v) => !v)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
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
