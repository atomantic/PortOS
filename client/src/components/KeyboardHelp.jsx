import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, X } from 'lucide-react';
import { useKeyboardHelp } from '../hooks/useKeyboardHelp';
import { useScrollLock } from '../hooks/useScrollLock';
import { modKey } from '../utils/platform';

const SHORTCUT_SECTIONS = [
  {
    title: 'Global',
    shortcuts: [
      { keys: [`${modKey}+K`], description: 'Open command palette' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close overlays' },
    ],
  },
  {
    title: 'Command Palette (when open)',
    shortcuts: [
      { keys: ['\u2191', '\u2193'], description: 'Navigate commands and results' },
      { keys: ['Enter'], description: 'Go to page, run action, or open result' },
      { keys: ['Esc'], description: 'Close palette' },
    ],
  },
  {
    title: 'CyberCity',
    shortcuts: [
      { keys: ['W', 'A', 'S', 'D'], description: 'Move around' },
      { keys: ['Tab'], description: 'Toggle mode' },
      { keys: ['E'], description: 'Interact with building' },
    ],
  },
];

function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono font-medium text-gray-300 bg-port-bg border border-port-border rounded shadow-sm">
      {children}
    </kbd>
  );
}

export default function KeyboardHelp() {
  const { open, setOpen } = useKeyboardHelp();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // Lock body scroll when open
  useScrollLock(open);

  // Focus management: capture previous focus, focus close button on open, restore on close
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      // Defer focus to after portal render
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [open]);

  // Focus trap: keep Tab/Shift+Tab within the dialog
  const handleKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  const overlay = (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={close}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-help-title"
        className="relative w-full max-w-lg mx-4 bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <div className="flex items-center gap-2.5">
            <Keyboard size={18} className="text-port-accent" />
            <h2 id="keyboard-help-title" className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
          </div>
          <button
            ref={closeButtonRef}
            onClick={close}
            className="p-1 text-gray-500 hover:text-white transition-colors rounded"
            aria-label="Close keyboard shortcuts"
          >
            <X size={16} />
          </button>
        </div>

        {/* Sections */}
        <div className="max-h-[60vh] overflow-y-auto p-5 space-y-5">
          {SHORTCUT_SECTIONS.map(section => (
            <div key={section.title}>
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2.5">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.shortcuts.map((shortcut, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm text-gray-300">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, j) => (
                        <Kbd key={j}>{key}</Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-port-border">
          <p className="text-xs text-gray-500 text-center">
            Press <Kbd>?</Kbd> to toggle this dialog
          </p>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
