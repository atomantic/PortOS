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
 * Fire keyboard shortcuts while `active` is truthy. `bindings` maps a
 * `KeyboardEvent.key` (e.g. `'a'`, `'ArrowLeft'`) to a handler; a falsy/absent
 * handler for a key is a no-op so callers can disable a shortcut by passing
 * `undefined` (e.g. an Accept that has no applicable fix). The event is
 * `preventDefault`-ed only when a binding actually matches.
 *
 * Which events reach the bindings at all is decided by the shared
 * `shouldIgnoreGlobalKey` predicate (lib/a11yKeyboard.js) — editable targets,
 * native Space button activation, ⌘/Ctrl/Alt chords, OS auto-repeat
 * (`{ ignoreRepeat: false }` to opt back in), and any keystroke while an
 * `aria-modal` dialog is open (`{ enabledInDialog: true }` for a shortcut that
 * genuinely lives inside a modal). That predicate documents why each guard
 * exists; it is shared with `useKeyCapture` so the two hooks can't drift.
 *
 * Bindings are read through a ref, so handlers recreated every render don't
 * re-subscribe the listener — only `active` does. The listener detaches while
 * inactive, so a closed card/popover keeps no global keydown handler around.
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
