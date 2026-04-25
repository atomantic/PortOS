import { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Check, Pencil } from 'lucide-react';

export default function LayoutPicker({ layouts, activeLayoutId, onSelect, onEdit }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
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

  return (
    <div ref={ref} className="relative">
      <button
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
          className="absolute right-0 mt-1 w-56 bg-port-card border border-port-border rounded-lg shadow-2xl overflow-hidden z-50"
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
                className={`w-full text-left flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 ${
                  l.id === activeLayoutId ? 'text-white' : 'text-gray-300'
                }`}
              >
                {l.id === activeLayoutId ? <Check size={14} className="text-port-success" aria-hidden="true" /> : <span className="w-3.5" aria-hidden="true" />}
                <span className="flex-1 truncate">{l.name}</span>
                {l.builtIn && <span className="text-[10px] text-gray-500 uppercase">Built-in</span>}
              </button>
            ))}
          </div>
          <div className="border-t border-port-border">
            <button
              onClick={() => { setOpen(false); onEdit(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white"
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
