/**
 * Keyboard-activation helpers for non-`<button>` clickables and global key handlers.
 *
 * Makes an element with `onClick` keyboard-operable (Enter/Space, `role`, `tabIndex`), plus predicates global key handlers consult: `<div onClick={select} {...clickableProps(select)}>`.
 */

/**
 * Build an `onKeyDown` handler that invokes `handler` on Enter or Space (Space is `preventDefault`ed so the page doesn't scroll); `undefined` when `handler` isn't a function.
 * @param {(event: KeyboardEvent) => void} handler
 * @returns {((event: KeyboardEvent) => void) | undefined}
 */
export function onActivateKeyDown(handler) {
  if (typeof handler !== 'function') return undefined;
  return (event) => {
    // Ignore keys bubbled from a focusable descendant (e.g. a row's Delete button), or we'd preventDefault its native activation.
    if (event.currentTarget != null && event.target !== event.currentTarget) return;
    // `' '` is the modern key value; `'Spacebar'` covers legacy engines.
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      handler(event);
    }
  };
}

/**
 * ARIA + keyboard props making a non-`<button>` clickable keyboard-accessible; spread alongside the element's `onClick`.
 * @param {(event: Event) => void} handler - The same activation handler wired to `onClick`.
 * @param {object} [options]
 * @param {string} [options.role='button'] - ARIA role to advertise.
 * @param {boolean} [options.disabled=false] - When true, marks the element `aria-disabled` and keeps it out of the tab order.
 * @returns {{ role: string, tabIndex?: number, onKeyDown?: Function, 'aria-disabled'?: boolean }}
 */
export function clickableProps(handler, { role = 'button', disabled = false } = {}) {
  if (disabled) {
    return { role, 'aria-disabled': true };
  }
  return {
    role,
    tabIndex: 0,
    onKeyDown: onActivateKeyDown(handler),
  };
}

/**
 * True when a keystroke is a Space press on a focused button-like element or native disclosure summary, where the browser activates the control.
 * App-global Space handlers (push-to-talk, shortcut maps) must stand down for these or they swallow every keyboard button press; anchors activate on Enter only.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isButtonActivation(event) {
  const isSpace = event?.key === ' ' || event?.key === 'Spacebar' || event?.code === 'Space';
  if (!isSpace) return false;
  const target = event.target;
  if (typeof target?.closest !== 'function') return false;
  return target.closest('button, [role="button"], details > summary:first-of-type') != null;
}

/**
 * True for "press this control" keys: Enter or Space, matched on `code` as well as `key` so raw `KeyboardEvent.code` surfaces (game/drill input) agree.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isPressKey(event) {
  return event?.key === 'Enter'
    || event?.key === ' '
    || event?.key === 'Spacebar'
    || event?.code === 'Space';
}

/**
 * True when an event came from a field the user is typing into (standard form fields or contentEditable), so single-key shortcuts and bare arrows never steal a keystroke.
 * @param {EventTarget | null} el
 * @returns {boolean}
 */
export function isEditableTarget(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * True when an event originated inside an interactive `role="application"` widget (such as the world map), which handles its own arrow/Space/Enter keys.
 * @param {EventTarget | null} el
 * @returns {boolean}
 */
export function isApplicationTarget(el) {
  return typeof el?.closest === 'function' && el.closest('[role="application"]') != null;
}

/**
 * The one predicate every app-global key handler (`useKeyboardShortcuts`, `useKeyCapture`) consults before acting on a window keystroke. Add new guards here, never at one caller (#4748).
 * Always ignored: editable targets, native button activation (`isButtonActivation`), and `role="application"` widgets (`isApplicationTarget`).
 * Ignored by default, opt out per handler:
 * - ⌘/Ctrl/Alt chords (`allowChords`); a raw physical-key handler (keyer, game) passes `true` because dropping a chorded keydown strands it with no keyup.
 * - OS auto-repeat (`ignoreRepeat`); a handler tracking press/release itself passes `false`.
 * - An open `aria-modal` dialog (`enabledInDialog`); a surface INSIDE the dialog opts back in.
 * @param {KeyboardEvent} event
 * @param {object}  [options]
 * @param {boolean} [options.enabledInDialog=false] act even while a dialog is open
 * @param {boolean} [options.ignoreRepeat=true]     drop OS auto-repeat keydowns
 * @param {boolean} [options.allowChords=false]     act on ⌘/Ctrl/Alt chords too
 * @returns {boolean} true when the handler must stand down
 */
export function shouldIgnoreGlobalKey(event, { enabledInDialog = false, ignoreRepeat = true, allowChords = false } = {}) {
  // Cheapest guards first: runs on every keystroke of every mounted consumer.
  if (!allowChords && (event.metaKey || event.ctrlKey || event.altKey)) return true;
  if (ignoreRepeat && event.repeat) return true;
  if (isEditableTarget(event.target)) return true;
  if (isButtonActivation(event)) return true;
  if (isApplicationTarget(event.target)) return true;
  if (!enabledInDialog && document.querySelector('[aria-modal="true"]')) return true;
  return false;
}

/**
 * True when a window keydown is the voice push-to-talk hotkey and nothing else owns the key. The voice widget and the gate that stands in for it while its chunk loads must agree, so both ask here.
 * Chords and open dialogs are let through on purpose: push-to-talk stays reachable while a modal is up. Editable targets (SELECT included), auto-repeat and Space on a focused button still stand it down.
 * @param {KeyboardEvent} event
 * @param {string} hotkey - the configured `KeyboardEvent.code` (default `Space`)
 * @returns {boolean}
 */
export function isPushToTalkKey(event, hotkey) {
  return event.code === hotkey && !shouldIgnoreGlobalKey(event, { allowChords: true, enabledInDialog: true });
}

/**
 * True for a backtab (Shift+Tab), the gesture a key-capturing widget must release to the browser (WCAG 2.1.2): `term.attachCustomKeyEventHandler((e) => !isFocusEscapeKey(e))`
 * for the Shell xterm; plain Tab stays claimed for completion. Chorded variants pass through to browser/OS shortcuts.
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isFocusEscapeKey(event) {
  return event?.key === 'Tab' && event?.shiftKey === true;
}

/**
 * Props for the ROOT of a surface that owns a key globally (drill, keyer, rig): suppressing `mousedown` focus stops a clicked button taking the key over.
 */
// Last control whose pointer focus was suppressed: `useFocusTrap` restores focus to it (WCAG 2.4.3) when nothing holds focus; only `isConnected` is checked.
let pointerFocusSuppressed = null;

export const noPointerFocusSurfaceProps = {
  onMouseDownCapture: (event) => {
    const control = event.target?.closest?.('button, [role="button"]');
    if (!control) return;
    event.preventDefault();
    pointerFocusSuppressed = control;
  },
};

/**
 * The control `noPointerFocusSurfaceProps` last kept focus off, if still in the document; focus restoration reads it when nothing is focused.
 * @returns {Element | null}
 */
export function pointerFocusSuppressedElement() {
  return pointerFocusSuppressed?.isConnected ? pointerFocusSuppressed : null;
}
