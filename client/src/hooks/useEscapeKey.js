import { useEffect, useRef } from 'react';

/**
 * Call `handler` when Escape is pressed, but only while `active` is truthy.
 * Listener is attached/removed with `active`, so a closed popover/card doesn't
 * keep a global keydown handler around. Use for non-modal dismissables (the
 * Modal component already owns Esc for true modals).
 *
 * `handler` is read through a ref, so an inline arrow recreated every parent
 * render (the common call-site shape) doesn't tear down + re-add the global
 * keydown listener on each render — only `active` flips the subscription.
 */
export default function useEscapeKey(active, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') handlerRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
