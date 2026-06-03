import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { getFamilyIcon } from '../themes/familyIcons';
import usePopoverPosition, { VIEWPORT_PADDING } from '../hooks/usePopoverPosition.js';

const MENU_WIDTH = 288;

export default function ThemeSwitcher({ position = 'above', className = '' }) {
  const { themeId, theme, themeList, setTheme } = useThemeContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const {
    triggerRef,
    popoverRef: menuRef,
    style: menuStyle,
  } = usePopoverPosition({ open, width: MENU_WIDTH, minWidth: 180, gap: 8, position });

  // Close on outside-click / Escape — the popover-position hook owns placement
  // and reflow; this component still owns its own dismiss semantics.
  useEffect(() => {
    if (!open) return undefined;

    const onMouseDown = (e) => {
      const clickedTrigger = containerRef.current?.contains(e.target);
      const clickedMenu = menuRef.current?.contains(e.target);
      if (!clickedTrigger && !clickedMenu) setOpen(false);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, menuRef]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="p-1.5 text-gray-500 hover:text-port-accent transition-colors"
        title="Switch theme"
        aria-label={`Switch theme. Current theme: ${theme?.label ?? 'Classic Midnight'}`}
        aria-expanded={open}
      >
        <Palette size={18} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
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
                  key={option.id}
                  onClick={() => { setTheme(option.id); setOpen(false); }}
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
