import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import useClickOutside from '../../hooks/useClickOutside';
import useEscapeKey from '../../hooks/useEscapeKey';

// "…" overflow menu for demoting rare/destructive row actions out of the
// always-visible control set, so the row keeps a single primary affordance.
// Keyboard: ArrowDown from the trigger opens and focuses the first item,
// ArrowUp/ArrowDown cycle, Escape closes and returns focus to the trigger.
// Items are >=40px tall so they stay tappable on a phone.
//
// Tones pre-compose full Tailwind class names — the JIT scans for complete
// tokens, so `text-port-${tone}` would NOT generate the utility.
const TONES = {
  default: 'text-gray-300 hover:bg-port-border hover:text-white',
  danger: 'text-port-error hover:bg-port-error/15',
};

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

export default function OverflowMenu({ label, items = [], className = '' }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useClickOutside(wrapperRef, open, () => setOpen(false));
  useEscapeKey(open, () => close(true));

  useEffect(() => {
    if (open) menuRef.current?.querySelector(ITEM_SELECTOR)?.focus();
  }, [open]);

  // Nothing to demote (e.g. a row whose destructive actions are all withheld) —
  // render no trigger rather than an empty menu.
  if (items.length === 0) return null;

  const moveFocus = (dir) => {
    const nodes = Array.from(menuRef.current?.querySelectorAll(ITEM_SELECTOR) || []);
    if (!nodes.length) return;
    const idx = nodes.indexOf(document.activeElement);
    const next = idx === -1 ? nodes[dir > 0 ? 0 : nodes.length - 1] : nodes[(idx + dir + nodes.length) % nodes.length];
    next?.focus();
  };

  const handleMenuKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Tab') {
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
        className="px-2 py-1.5 min-h-[40px] sm:min-h-0 inline-flex items-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-30 min-w-[11rem] rounded-lg border border-port-border bg-port-card shadow-lg py-1"
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
              className={`w-full px-3 py-2 min-h-[40px] text-left text-xs flex items-center gap-2 transition-colors disabled:opacity-50 focus:outline-hidden focus:bg-port-border/70 ${TONES[item.tone] || TONES.default}`}
            >
              {item.icon ? <item.icon size={14} aria-hidden="true" /> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
