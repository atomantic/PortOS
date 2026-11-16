/**
 * `useKeyCapture({ enabled?, enabledInDialog?, onKeyDown, onKeyUp })` — capture-phase window listener
 * whose handler *claims* an event by returning `true`.
 */

import { useEffect, useRef } from 'react';
import { shouldIgnoreGlobalKey } from '../lib/a11yKeyboard.js';

// A claiming surface reads a raw physical key and tracks press/release itself, so two shared guards are relaxed: auto-repeat keydowns must arrive (the Morse keyer preventDefaults every
// tick of a held Space) and so must ⌘/Ctrl/Alt chords (dropping one strands it with no keyup). The dialog guard stays a caller option; the editable-target and button-activation guards have no opt-out.
const CLAIM_GUARDS = { ignoreRepeat: false, allowChords: true };

/**
 * Capture-phase keyboard listener whose handlers *claim* an event by returning true. A claimed event is `preventDefault`ed and `stopImmediatePropagation`ed so no app-global bubble-phase
 * handler sees it (notably the voice widget's push-to-talk hotkey, default `Space`). Un-claimed events pass through, so this never becomes a blanket keyboard trap.
 *
 * Which events are offered is decided by the shared `shouldIgnoreGlobalKey` predicate (lib/a11yKeyboard.js), also used by `useKeyboardShortcuts` so the hooks can't drift:
 * - Events from an editable field are never offered.
 * - **Space on a focused button is never offered**, so native activation still happens (a claiming surface renders its own buttons; #4748).
 * - Nor are events while an `aria-modal` dialog is open (claiming Escape would dismiss the surface instead of the layer in view); a surface INSIDE a dialog passes `enabledInDialog: true`.
 *
 * Guards run on KEYDOWN only; the keyup mirrors that decision so a claimed press is always released even if focus or a dialog changed mid-press.
 *
 * Handlers are read through refs, so inline arrows don't re-subscribe; only `enabled` flips the subscription, and an absent handler doesn't subscribe its listener.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.enabled=true]           attach while truthy
 * @param {boolean}  [opts.enabledInDialog=false]  also fire while a dialog is open
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyDown] return true to claim
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyUp]   return true to claim
 */
export default function useKeyCapture({ enabled = true, enabledInDialog = false, onKeyDown, onKeyUp } = {}) {
  const downRef = useRef(onKeyDown);
  const upRef = useRef(onKeyUp);
  downRef.current = onKeyDown;
  upRef.current = onKeyUp;
  // Keys whose keydown the guards turned away, so the matching keyup makes the same call.
  const ignoredDownRef = useRef(new Set());

  // Presence, not identity: a call site always passing a handler keeps one stable subscription.
  const hasDown = Boolean(onKeyDown);
  const hasUp = Boolean(onKeyUp);

  useEffect(() => {
    if (!enabled) return undefined;
    const guards = { ...CLAIM_GUARDS, enabledInDialog };
    const ignoredDown = ignoredDownRef.current;
    // The keyup MIRRORS the keydown's decision rather than re-evaluating guards that read mid-press state: native button activation needs keydown AND keyup on the same element, so re-asking
    // would swallow the release (Tab/click onto a button while Space is held, or a dialog opening) and strand a press, e.g. a Morse keyer stuck transmitting.
    const claim = (ref, isDown) => (e) => {
      if (isDown) {
        if (shouldIgnoreGlobalKey(e, guards)) { ignoredDown.add(e.code || e.key); return; }
        ignoredDown.delete(e.code || e.key);
      } else if (hasDown ? ignoredDown.delete(e.code || e.key) : shouldIgnoreGlobalKey(e, guards)) {
        // Mirroring needs this hook to have seen the keydown; a keyup-only caller evaluates the guards directly.
        return;
      }
      if (ref.current?.(e) !== true) return;
      e.preventDefault();
      // Subsumes stopPropagation: also skips the remaining listeners on window.
      e.stopImmediatePropagation();
    };
    const down = hasDown ? claim(downRef, true) : null;
    const up = hasUp ? claim(upRef, false) : null;
    if (down) window.addEventListener('keydown', down, true);
    if (up) window.addEventListener('keyup', up, true);
    return () => {
      if (down) window.removeEventListener('keydown', down, true);
      if (up) window.removeEventListener('keyup', up, true);
      // A key held across an unsubscribe has no keyup to clear it.
      ignoredDown.clear();
    };
  }, [enabled, enabledInDialog, hasDown, hasUp]);
}
