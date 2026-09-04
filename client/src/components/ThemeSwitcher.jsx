import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { getFamilyIcon } from '../themes/familyIcons';
import usePopoverPosition, { VIEWPORT_PADDING } from '../hooks/usePopoverPosition.js';
import useClickOutside from '../hooks/useClickOutside.js';
import useEscapeKey from '../hooks/useEscapeKey.js';

const MENU_WIDTH = 288;
const ITEM_SELECTOR = '[role="menuitemradio"]';
const TABBABLE_SELECTOR = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

export default function ThemeSwitcher({ position = 'above', className = '' }) {
  const { themeId, theme, themeList, setTheme } = useThemeContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const {
    triggerRef,
    popoverRef: menuRef,
    style: menuStyle,
  } = usePopoverPosition({ open, width: MENU_WIDTH, minWidth: 180, gap: 8, position });

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, [triggerRef]);

  // Close on outside-click / Escape — the popover-position hook owns placement
  // and reflow; this component still owns its own dismiss semantics. The menu is
  // portaled to <body>, so both the trigger container and the panel have to count
  // as "inside" — that's what the array form of useClickOutside is for.
  useClickOutside([containerRef, menuRef], open, () => setOpen(false));
  useEscapeKey(open, () => close(true));

  useEffect(() => {
    if (!open || !menuStyle) return;
    const selected = menuRef.current?.querySelector(`${ITEM_SELECTOR}[aria-checked="true"]`);
    (selected ?? menuRef.current?.querySelector(ITEM_SELECTOR))?.focus();
  }, [open, menuRef, menuStyle]);

  const menuItems = () => Array.from(menuRef.current?.querySelectorAll(ITEM_SELECTOR) ?? []);

  const focusItem = (index) => {
    const items = menuItems();
    items[(index + items.length) % items.length]?.focus();
  };

  const moveFocus = (direction) => {
    const items = menuItems();
    const current = items.indexOf(document.activeElement);
    focusItem(current === -1 ? (direction > 0 ? 0 : items.length - 1) : current + direction);
  };

  const focusPastTrigger = (backwards) => {
    const trigger = triggerRef.current;
    const items = Array.from(document.querySelectorAll(TABBABLE_SELECTOR))
      .filter(element => !menuRef.current?.contains(element));
    const triggerIndex = items.indexOf(trigger);
    const next = triggerIndex === -1 ? null : items[triggerIndex + (backwards ? -1 : 1)];
    (next ?? trigger)?.focus();
  };

  const handleMenuKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(-1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      focusPastTrigger(event.shiftKey);
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-accent transition-colors"
        title="Switch theme"
        aria-label={`Switch theme. Current theme: ${theme?.label ?? 'Classic Midnight'}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette size={18} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Interface theme"
          onKeyDown={handleMenuKeyDown}
          className="fixed max-w-[calc(100vw-1rem)] bg-port-card border border-port-border rounded-xl shadow-xl z-[100] p-2"
          style={{
            left: menuStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: menuStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: menuStyle?.width ?? `${MENU_WIDTH}px`,
            visibility: menuStyle ? 'visible' : 'hidden',
          }}
        >
          <div className="px-2 py-1.5 text-xs font-medium uppercase text-gray-500">
            Interface theme
          </div>
          <div className="space-y-1">
            {themeList.map(option => {
              const Icon = getFamilyIcon(option.family);
              const active = themeId === option.id;
              return (
                <button
                  type="button"
                  key={option.id}
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => { setTheme(option.id); close(true); }}
                  className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-port-accent/10 text-port-accent'
                      : 'text-gray-400 hover:text-white hover:bg-port-border/50'
                  }`}
                >
                  <span className="relative w-8 h-8 rounded-lg border border-port-border bg-port-bg shrink-0 overflow-hidden flex items-center justify-center">
                    <span className="absolute inset-x-0 bottom-0 h-2" style={{ backgroundColor: option.accent }} />
                    <Icon size={16} className="relative" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block font-medium truncate">{option.label}</span>
                    <span className="block text-xs text-gray-500 truncate">{option.shortLabel} - {option.density}</span>
                  </span>
                  {active && <Check size={16} className="shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
