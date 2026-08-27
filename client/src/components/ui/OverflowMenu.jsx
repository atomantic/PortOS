import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';
import useEscapeKey from '../../hooks/useEscapeKey';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../hooks/usePopoverPosition.js';

// "…" overflow menu for demoting rare/destructive row actions out of the
// always-visible control set, so the row keeps a single primary affordance.
// Keyboard: ArrowDown from the trigger opens and focuses the first item,
// ArrowUp/ArrowDown cycle, Escape closes and returns focus to the trigger.
// Trigger and items are >=44px on phones (the repo's touch-target floor) and
// relax to the denser desktop sizing from `sm` up.
// The menu is portaled and fixed-positioned so clipped cards and dashboard
// stacking contexts cannot move or hide the app row when it opens.
//
// Tones pre-compose full Tailwind class names — the JIT scans for complete
// tokens, so `text-port-${tone}` would NOT generate the utility.
const TONES = {
  default: 'text-gray-300 hover:bg-port-border hover:text-white',
  danger: 'text-port-error hover:bg-port-error/15',
};

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';
const TABBABLE_SELECTOR = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const MENU_WIDTH = 176;

export default function OverflowMenu({ label, items = [], className = '', triggerRef: externalTriggerRef }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  // Callers that dismiss follow-up UI opened from an item (an inline confirm)
  // pass `triggerRef` so they can hand focus back to the trigger it came from.
  const { triggerRef, popoverRef, style } = usePopoverPosition({
    open,
    anchorRef: externalTriggerRef || null,
    width: MENU_WIDTH,
    minWidth: MENU_WIDTH,
    gap: 4,
    position: 'below',
  });

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useClickOutside([wrapperRef, popoverRef], open, () => setOpen(false));
  useEscapeKey(open, () => close(true));

  useEffect(() => {
    if (open) popoverRef.current?.querySelector(ITEM_SELECTOR)?.focus();
  }, [open]);

  // Nothing to demote (e.g. a row whose destructive actions are all withheld) —
  // render no trigger rather than an empty menu.
  if (items.length === 0) return null;

  const moveFocus = (dir) => {
    const nodes = Array.from(popoverRef.current?.querySelectorAll(ITEM_SELECTOR) || []);
    if (!nodes.length) return;
    const idx = nodes.indexOf(document.activeElement);
    const next = idx === -1 ? nodes[dir > 0 ? 0 : nodes.length - 1] : nodes[(idx + dir + nodes.length) % nodes.length];
    next?.focus();
  };

  // Move focus to the element that would follow (or precede) the trigger in the
  // document's tab order, ignoring the menu's own items. Falls back to the
  // trigger when it's at the end of the sequence.
  const focusPastTrigger = (backwards) => {
    const trigger = triggerRef.current;
    const nodes = Array.from(document.querySelectorAll(TABBABLE_SELECTOR))
      .filter(el => !popoverRef.current?.contains(el));
    const idx = nodes.indexOf(trigger);
    const next = idx === -1 ? null : nodes[idx + (backwards ? -1 : 1)];
    (next || trigger)?.focus();
  };

  const handleMenuKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Tab') {
      // Tab leaves the menu. The default move can't be relied on — the focused
      // item unmounts in the same interaction, which strands focus on <body> —
      // so drive it explicitly: continue the tab sequence from the trigger, as
      // if the menu had never been open.
      e.preventDefault();
      focusPastTrigger(e.shiftKey);
      setOpen(false);
    }
  };

  return (
    <div className={`relative ${className}`.trim()} ref={wrapperRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="px-2 py-1.5 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className="fixed z-30 max-w-[calc(100vw-1rem)] rounded-lg border border-port-border bg-port-card shadow-lg py-1"
          style={{
            left: style?.left ?? `${VIEWPORT_PADDING}px`,
            top: style?.top ?? `${VIEWPORT_PADDING}px`,
            width: style?.width ?? `${MENU_WIDTH}px`,
            visibility: style ? 'visible' : 'hidden',
          }}
        >
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              // Close first so focus lands somewhere real; an item that reveals
              // follow-up UI (an inline confirm) owns moving focus onward from
              // there — its mount effect runs after this commit and wins.
              onClick={() => { close(true); item.onSelect?.(); }}
              className={`w-full px-3 py-2 min-h-[44px] sm:min-h-[40px] text-left text-xs flex items-center gap-2 transition-colors disabled:opacity-50 focus:outline-hidden focus:bg-port-border/70 ${TONES[item.tone] || TONES.default}`}
            >
              {item.icon ? <item.icon size={14} aria-hidden="true" /> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
