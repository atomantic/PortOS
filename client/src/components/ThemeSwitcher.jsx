import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import { useThemeContext } from './ThemeContext';
import { getFamilyIcon } from '../themes/familyIcons';

const MENU_WIDTH = 288;
const MENU_GAP = 8;
const VIEWPORT_PADDING = 8;

export default function ThemeSwitcher({ position = 'above', className = '' }) {
  const { themeId, theme, themeList, setTheme } = useThemeContext();
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(MENU_WIDTH, Math.max(180, viewportWidth - VIEWPORT_PADDING * 2));

    // Apply width before measuring height — narrow viewports may wrap content
    // and grow the menu's height. Measuring at the wrong width produces a
    // top value that under-clamps and lets the portal overflow.
    menu.style.width = `${width}px`;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = viewportWidth - width - VIEWPORT_PADDING;
    const left = Math.min(
      Math.max(triggerRect.right - width, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, maxLeft)
    );

    const aboveTop = triggerRect.top - menuRect.height - MENU_GAP;
    const belowTop = triggerRect.bottom + MENU_GAP;
    const wouldOverflowTop = aboveTop < VIEWPORT_PADDING;
    const wouldOverflowBottom = belowTop + menuRect.height > viewportHeight - VIEWPORT_PADDING;

    let top = position === 'above'
      ? (wouldOverflowTop ? belowTop : aboveTop)
      : (wouldOverflowBottom ? aboveTop : belowTop);

    const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - menuRect.height - VIEWPORT_PADDING);
    top = Math.min(Math.max(top, VIEWPORT_PADDING), maxTop);

    setMenuStyle(prev => {
      if (prev && prev.left === `${left}px` && prev.top === `${top}px` && prev.width === `${width}px`) {
        return prev;
      }
      return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
    });
  }, [position]);

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

    let rafId = null;
    const onReposition = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateMenuPosition();
      });
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
  }, [open, updateMenuPosition]);

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
