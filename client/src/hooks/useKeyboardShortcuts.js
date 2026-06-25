import { useEffect, useRef } from 'react';

// True when an event came from a field the user is typing into, so a single-key
// shortcut (a/d/g/j/k) or a bare arrow never steals a keystroke or caret move.
// The standard form fields plus any contentEditable surface count.
export function isEditableTarget(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Fire keyboard shortcuts while `active` is truthy. `bindings` maps a
 * `KeyboardEvent.key` (e.g. `'a'`, `'ArrowLeft'`) to a handler; a falsy/absent
 * handler for a key is a no-op so callers can disable a shortcut by passing
 * `undefined` (e.g. an Accept that has no applicable fix). Events that originate
 * from an editable field are ignored (so typing the letter `d` never dismisses),
 * and any ⌘/Ctrl/Alt chord is skipped so app/browser shortcuts still win. The
 * event is `preventDefault`-ed only when a binding actually matches.
 *
 * Bindings are read through a ref, so handlers recreated every render don't
 * re-subscribe the listener — only `active` does. The listener detaches while
 * inactive, so a closed card/popover keeps no global keydown handler around.
 */
export default function useKeyboardShortcuts(active, bindings) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const handler = bindingsRef.current[e.key];
      if (typeof handler !== 'function') return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}
