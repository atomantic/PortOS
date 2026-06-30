import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useScrollLock } from '../hooks/useScrollLock';

// Right-side slide-in panel for "settings over a feature page" pattern.
// Mobile (<sm): full width. Desktop: ~520px. Backdrop click + Esc close it.
// Caller controls open state — typically driven by a URL search param so the
// view stays deep-linkable per the project convention.
// Long-lived forms (e.g. the app-edit drawer) can opt out of accidental
// dismissal via closeOnEsc / closeOnBackdrop so an Esc keystroke mid-edit
// doesn't discard the form.
export default function Drawer({
  open,
  onClose,
  title,
  children,
  widthClass = 'sm:w-[520px]',
  closeOnEsc = true,
  closeOnBackdrop = true,
  closeLabel = 'Close settings'
}) {
  useScrollLock(open);

  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeOnEsc]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed inset-y-0 right-0 z-50 w-full ${widthClass} bg-port-card border-l border-port-border shadow-2xl flex flex-col`}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h2 className="text-base font-medium text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label={closeLabel}
          >
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </aside>
    </>
  );
}
