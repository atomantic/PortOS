import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { LayoutGrid, Check, Pencil } from 'lucide-react';

export default function LayoutPicker({ layouts, activeLayoutId, onSelect, onEdit }) {
  const [open, setOpen] = useState(false);
  // Computed fixed-position style applied only when right-aligning to the
  // trigger button would push the dropdown off the left edge of the
  // viewport (typical on mobile, where the picker sits mid-row). Null →
  // use the default `absolute right-0` placement.
  const [menuPos, setMenuPos] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const active = layouts.find((l) => l.id === activeLayoutId) || layouts[0];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const compute = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      const padding = 8;
      const desiredWidth = 224; // matches w-56
      // If aligning the dropdown's right edge with the button's right edge
      // would clip the left side, anchor it to the viewport's right edge
      // instead via fixed positioning.
      const next = rect.right - desiredWidth < padding
        ? { position: 'fixed', top: rect.bottom + 4, right: padding, left: 'auto' }
        : null;
      // Same-reference updater short-circuits when nothing changed so the
      // capture-phase scroll listener doesn't trigger a re-render every
      // pixel — important on mobile where this fires at touch-scroll rate.
      setMenuPos((prev) => {
        if (prev === next) return prev;
        if (!prev || !next) return next;
        if (prev.top === next.top && prev.right === next.right) return prev;
        return next;
      });
    };
    compute();
    window.addEventListener('resize', compute);
    // Capture-phase scroll catches scrolls in any ancestor (the Dashboard
    // sits inside Layout's overflow-auto <main>, so window-level scroll
    // events alone wouldn't fire and the fixed-positioned menu would
    // detach from its trigger as the page scrolled).
    window.addEventListener('scroll', compute, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, { capture: true });
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border hover:border-gray-600 transition-colors text-sm text-gray-300 hover:text-white min-h-[40px] focus:outline-hidden focus:ring-2 focus:ring-port-accent focus:ring-offset-2 focus:ring-offset-port-bg"
        title="Switch dashboard layout"
        aria-label={`Dashboard layout: ${active?.name || 'none'}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <LayoutGrid size={14} aria-hidden="true" />
        <span className="hidden sm:inline">{active?.name || 'Layout'}</span>
      </button>

      {open && (
        <div
          aria-label="Dashboard layout menu"
          className={`w-56 max-w-[calc(100vw-1rem)] bg-port-card border border-port-border rounded-lg shadow-2xl overflow-hidden z-50 ${menuPos ? '' : 'absolute right-0 mt-1'}`}
          style={menuPos || undefined}
        >
          <div className="py-1">
            {layouts.map((l) => (
              <button
                key={l.id}
                aria-current={l.id === activeLayoutId ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  // onSelect performs an API write; request() toasts any
                  // failure, swallow here to avoid unhandled rejections.
                  Promise.resolve(onSelect(l.id)).catch(() => {});
                }}
                className={`w-full text-left flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 min-h-[40px] ${
                  l.id === activeLayoutId ? 'text-white' : 'text-gray-300'
                }`}
              >
                {l.id === activeLayoutId ? <Check size={14} className="text-port-success shrink-0" aria-hidden="true" /> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
                <span className="flex-1 truncate">{l.name}</span>
                {l.builtIn && <span className="text-[10px] text-gray-500 uppercase shrink-0">Built-in</span>}
              </button>
            ))}
          </div>
          <div className="border-t border-port-border">
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white min-h-[40px]"
            >
              <Pencil size={14} aria-hidden="true" />
              <span>Edit layouts…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
