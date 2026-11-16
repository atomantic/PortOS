/**
 * `useKeyboardShortcuts(active, bindings, opts?)` — fire a `{ key: handler }` map while `active`.
 *
 * Ignores whatever the shared `shouldIgnoreGlobalKey` predicate (`lib/a11yKeyboard.js`) rules out —
 * editable fields, Space on a focused button, ⌘/Ctrl/Alt chords, OS key auto-repeat (`{ ignoreRepeat:
 * false }` to opt back in), and any keystroke while an `aria-modal` dialog is open (`{
 * enabledInDialog: true }` for a modal-owned shortcut); a falsy handler disables that key. Use when:
 * Single-surface action shortcuts (editorial comment card prev/next + accept/dismiss/generate, #1603).
 * Not for held-key game input.
 */

import { useEffect, useRef } from 'react';
import { shouldIgnoreGlobalKey } from '../lib/a11yKeyboard.js';

/**
 * Fire keyboard shortcuts while `active` is truthy. `bindings` maps a `KeyboardEvent.key` (e.g. `'a'`, `'ArrowLeft'`) to a handler; a falsy handler is a no-op so callers can disable a shortcut by passing `undefined`. The event is `preventDefault`-ed only when a binding matches.
 * Which events reach the bindings is decided by the shared `shouldIgnoreGlobalKey` predicate (lib/a11yKeyboard.js), which documents each guard and is shared with `useKeyCapture` so the hooks can't drift (`{ ignoreRepeat: false }` and `{ enabledInDialog: true }` opt out).
 * Bindings are read through a ref, so recreated handlers don't re-subscribe; only `active` does, and the listener detaches while inactive so a closed card/popover keeps no global keydown handler.
 */
export default function useKeyboardShortcuts(active, bindings, { ignoreRepeat = true, enabledInDialog = false } = {}) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    if (!active) return undefined;
    const guards = { ignoreRepeat, enabledInDialog };
    const onKey = (e) => {
      if (shouldIgnoreGlobalKey(e, guards)) return;
      const handler = bindingsRef.current[e.key];
      if (typeof handler !== 'function') return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, ignoreRepeat, enabledInDialog]);
}
