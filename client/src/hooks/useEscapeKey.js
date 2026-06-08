import { useEffect } from 'react';

/**
 * Call `handler` when Escape is pressed, but only while `active` is truthy.
 * Listener is attached/removed with `active`, so a closed popover/card doesn't
 * keep a global keydown handler around. Use for non-modal dismissables (the
 * Modal component already owns Esc for true modals).
 */
export default function useEscapeKey(active, handler) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') handler(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, handler]);
}
