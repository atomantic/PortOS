import { useState, useRef, useEffect } from 'react';
import { Palette } from 'lucide-react';
import { useThemeContext } from './ThemeContext';

export default function ThemeSwitcher({ position = 'above' }) {
  const { themeId, themes, setTheme } = useThemeContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handle = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 text-gray-500 hover:text-port-accent transition-colors"
        title="Switch theme"
        aria-label="Switch theme"
        aria-expanded={open}
      >
        <Palette size={18} />
      </button>

      {open && (
        <div
          className={`absolute ${
            position === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'
          } right-0 w-44 bg-port-card border border-port-border rounded-lg shadow-xl z-50 py-1`}
        >
          {Object.entries(themes).map(([id, theme]) => (
            <button
              key={id}
              onClick={() => { setTheme(id); setOpen(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
                themeId === id
                  ? 'bg-port-accent/10 text-port-accent'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0 border border-white/20"
                style={{ backgroundColor: theme.accent }}
              />
              {theme.label}
              {themeId === id && <span className="ml-auto text-xs opacity-60">Active</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
