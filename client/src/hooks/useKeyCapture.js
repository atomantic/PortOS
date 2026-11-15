/**
 * `useKeyCapture({ enabled?, enabledInDialog?, onKeyDown, onKeyUp })` — capture-phase window listener
 * whose handler *claims* an event by returning `true`.
 *
 * A claimed event is `preventDefault`ed AND `stopImmediatePropagation`ed so no app-global bubble
 * handler sees it. Which events are offered is decided by the shared `shouldIgnoreGlobalKey` predicate
 * (`lib/a11yKeyboard.js`): never events from an editable field, never Space on a focused button (so
 * native activation still works), and not while an `aria-modal` dialog is open (`{ enabledInDialog:
 * true }` for a surface that lives INSIDE one — same name and default as `useKeyboardShortcuts`).
 * Auto-repeat and ⌘/Ctrl/Alt chords deliberately DO still arrive, because a claiming surface tracks
 * press/release itself. Each listener subscribes only when its handler is supplied. Use when: A
 * surface that must own a key an app-global handler already binds — chiefly Space, which the voice
 * widget uses for push-to-talk: the POST cognitive drills (n-back, go/no-go, reaction-time), the Morse
 * keyer, RapidReader, the OpenWorld playback transport, and the exploration-mode jump key. Not for
 * ordinary shortcuts (that is `useKeyboardShortcuts`).
 */

import { useEffect, useRef } from 'react';
import { shouldIgnoreGlobalKey } from '../lib/a11yKeyboard.js';

// A claiming surface reads a raw physical key and tracks press/release itself,
// so two of the shared guards are deliberately relaxed for it: auto-repeat
// keydowns must still arrive (the Morse keyer `preventDefault`s every tick of a
// held Space, or the page scrolls under it), and so must ⌘/Ctrl/Alt chords
// (dropping a chorded keydown strands it with no matching keyup). The dialog
// guard stays a caller option; the editable-target and button-activation guards
// have no opt-out at all.
const CLAIM_GUARDS = { ignoreRepeat: false, allowChords: true };

/**
 * Capture-phase keyboard listener whose handlers *claim* an event by returning
 * true. A claimed event is `preventDefault`ed and `stopImmediatePropagation`ed,
 * so no app-global bubble-phase handler ever sees it — notably the voice
 * widget's push-to-talk hotkey, which defaults to `Space` and would otherwise
 * open the mic every time the user hits Space on a Space-driven surface.
 * Un-claimed events pass through untouched, so this never becomes a blanket
 * keyboard trap.
 *
 * Which events are offered to the handlers is decided by the shared
 * `shouldIgnoreGlobalKey` predicate (lib/a11yKeyboard.js), also used by
 * `useKeyboardShortcuts` so the two hooks can't drift apart:
 *
 * - Events originating in an editable field are never offered, so a Space-driven
 *   surface that also has a text input keeps normal typing.
 * - **Space on a focused button is never offered**, so the browser's native
 *   activation still happens. A claiming surface almost always renders its own
 *   buttons (a drill's Start/Match, RapidReader's transport, the keyer's mode
 *   switches); without this, tabbing to one and pressing Space ran the claimed
 *   action instead of pressing the button — the exact stand-down the voice
 *   widget and `useKeyboardShortcuts` already performed (#4748).
 * - Nor are events fired while an `aria-modal` dialog is open: the surface is
 *   behind that dialog, and claiming Escape there would dismiss the surface
 *   instead of the layer the user is actually looking at. A surface that itself
 *   lives INSIDE a dialog passes `enabledInDialog: true` to opt back in. Both the
 *   option name and its default mirror `useKeyboardShortcuts`.
 *
 * The guards are evaluated on the KEYDOWN only; the keyup half mirrors that
 * decision, so a press that was claimed is always released, even if focus or an
 * open dialog changed while the key was held.
 *
 * Handlers are read through refs, so inline arrows recreated every render (the
 * common call-site shape) don't tear down and re-add the listeners; only
 * `enabled` flips the subscription. A handler that is absent entirely doesn't
 * subscribe its listener at all.
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
  // Keys whose keydown the guards turned away, so the matching keyup can make
  // the same call — see the mirroring note below.
  const ignoredDownRef = useRef(new Set());

  // Presence, not identity — a call site that always passes a handler keeps one
  // stable subscription no matter how often its inline arrow is recreated.
  const hasDown = Boolean(onKeyDown);
  const hasUp = Boolean(onKeyUp);

  useEffect(() => {
    if (!enabled) return undefined;
    const guards = { ...CLAIM_GUARDS, enabledInDialog };
    const ignoredDown = ignoredDownRef.current;
    // The keyup half MIRRORS whatever the keydown decided rather than
    // re-evaluating the guards, because the guards read state that can change
    // mid-press. Native button activation needs the keydown AND the keyup on the
    // same element, so re-asking on keyup gets it wrong in both directions: Tab
    // (or a click) onto a button while Space is held would swallow the release
    // and strand a handler that began a press on the keydown — a Morse keyer
    // stuck transmitting — while a dialog opening mid-press would do the same.
    const claim = (ref, isDown) => (e) => {
      if (isDown) {
        if (shouldIgnoreGlobalKey(e, guards)) { ignoredDown.add(e.code || e.key); return; }
        ignoredDown.delete(e.code || e.key);
      } else if (hasDown ? ignoredDown.delete(e.code || e.key) : shouldIgnoreGlobalKey(e, guards)) {
        // Mirroring only works when this hook actually saw the keydown. A
        // keyup-only caller has no decision to mirror, so it evaluates the
        // guards directly — otherwise its releases would bypass them entirely.
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
