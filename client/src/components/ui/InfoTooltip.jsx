import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import usePopoverPosition from '../../hooks/usePopoverPosition';
import useCancelableDebounce from '../../hooks/useCancelableDebounce';
import useEscapeKey from '../../hooks/useEscapeKey';
import { Info } from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';

// The trigger keeps a 44x44px minimum hit area at every width (touch input is not
// detectable by breakpoint); the negative vertical margin stops it growing rows.
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
//
// Panels portal to body so glass-card stacking contexts and content scrollers
// cannot obscure help. Placement flips and clamps to the viewport.
export default function InfoTooltip({
  children,
  label = 'More information',
  className = '',
  panelClassName = '',
  width = 224,
  iconSize = 14,
  align = 'center',
  placement = 'above',
}) {
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef(null);
  const panelId = useId();
  const visible = pinned || hovering || focused;
  const [scheduleClose, cancelClose] = useCancelableDebounce();
  const { triggerRef, popoverRef, style } = usePopoverPosition({
    open: visible, width, minWidth: 0, gap: 6, position: placement, align, constrainHeight: true,
    contentDeps: [children, panelClassName],
  });

  const close = useCallback(() => {
    cancelClose();
    setPinned(false);
    setHovering(false);
    setFocused(false);
  }, [cancelClose]);

  const onMouseEnter = () => {
    cancelClose();
    setHovering(true);
  };
  // A short grace period bridges the physical gap between trigger and portal.
  const onMouseLeave = () => scheduleClose(() => setHovering(false), 150);
  const onFocus = () => setFocused(true);
  const onBlur = (event) => {
    if (wrapRef.current?.contains(event.relatedTarget)
      || popoverRef.current?.contains(event.relatedTarget)) return;
    setFocused(false);
  };

  useClickOutside([wrapRef, popoverRef], visible, close);

  useEscapeKey(visible, () => {
    // Return keyboard scroll focus before removing the portal.
    if (popoverRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    close();
  });

  return (
    <div
      ref={wrapRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={visible ? panelId : undefined}
        onClick={() => { if (pinned) close(); else setPinned(true); }}
        onKeyDown={(event) => {
          const panel = popoverRef.current;
          if (event.key === 'Tab' && !event.shiftKey && panel?.scrollHeight > panel?.clientHeight) {
            event.preventDefault();
            panel.focus();
          }
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        className="inline-flex shrink-0 items-center justify-center min-h-[44px] min-w-[44px] -my-[15px] rounded text-gray-500 transition-colors hover:text-gray-300 focus:text-gray-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent"
      >
        <Info size={iconSize} aria-hidden="true" />
      </button>
      {visible && createPortal(
        <div
          ref={popoverRef}
          id={panelId}
          role="tooltip"
          tabIndex={0}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              // Continue from the trigger's place in the caller's tab order.
              triggerRef.current?.focus();
              if (event.shiftKey) event.preventDefault();
            }
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          style={{ ...style, visibility: style ? undefined : 'hidden' }}
          className={`port-opaque-surface fixed z-[100] overflow-y-auto rounded-lg border border-port-border px-3 py-2 text-xs text-gray-300 shadow-lg ${panelClassName}`}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
