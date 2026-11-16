/**
 * Keyboard-activation helpers for non-`<button>` clickables and global key handlers.
 *
 * Makes an element with `onClick` keyboard-operable (`role="button"`, `tabIndex=0`,
 * Enter/Space handler), plus the shared predicates global key handlers consult
 * before claiming a key. Native `<button>` is preferable; usage: `<div onClick={select} {...clickableProps(select)}>`.
 */

/**
 * Build an `onKeyDown` handler that invokes `handler` when the user presses
 * Enter or Space on a focused element. Space is `preventDefault`ed so the
 * page doesn't scroll. Returns `undefined` when `handler` isn't a function so
 * it can be spread safely.
 *
 * @param {(event: KeyboardEvent) => void} handler
 * @returns {((event: KeyboardEvent) => void) | undefined}
 */
export function onActivateKeyDown(handler) {
  if (typeof handler !== 'function') return undefined;
  return (event) => {
    // Ignore keys bubbled from a focusable descendant (e.g. a row's Delete
    // button), or we'd preventDefault its native activation. `currentTarget`
    // is null only for synthetic test events, where the guard is a no-op.
    if (event.currentTarget != null && event.target !== event.currentTarget) return;
    // `' '` is the modern key value; `'Spacebar'` covers legacy engines.
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      handler(event);
    }
  };
}

/**
 * Return the ARIA + keyboard props that make a non-`<button>` clickable
 * element keyboard-accessible. Spread alongside the element's existing
 * `onClick` handler.
 *
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
 * True when a keystroke is a Space press on a focused button-like element or
 * native disclosure summary, where the browser will activate the control.
 *
 * App-global single-key handlers bound to Space (the voice widget's
 * push-to-talk hotkey, page-level shortcut maps) must stand down for these:
 * `preventDefault`ing here would swallow every keyboard button press in the app
 * and run the global action instead. Scoped to Space and to button-like targets
 * only — anchors do NOT activate on Space (Enter only), so exempting them would
 * just make Space dead on a focused link.
 *
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
 * True for the keys that count as "press this control": Enter or Space. Matches
 * on `code` as well as `key`, so a surface reading raw `KeyboardEvent.code`
 * (game/drill input) and one reading `key` agree on what a press is.
 *
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
 * True when an event came from a field the user is typing into, so a single-key
 * shortcut (a/d/g/j/k), a bare arrow, or a Space-claiming surface never steals a
 * keystroke or caret move. The standard form fields plus any contentEditable
 * surface count.
 *
 * @param {EventTarget | null} el
 * @returns {boolean}
 */
export function isEditableTarget(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * The one predicate every app-global key handler (`useKeyboardShortcuts`,
 * `useKeyCapture`) consults before acting on a window keystroke: "is this event
 * off-limits to me?". Add new guards here, never at one caller (#4748).
 *
 * Always ignored, with no opt-out:
 * - **Editable targets** — typing into an input/textarea/select/contentEditable.
 * - **Native button activation** (`isButtonActivation`) — Space on a focused
 *   button-like element, where the browser is about to click it. Claiming that
 *   press swallows every keyboard button activation on the surface and runs the
 *   global action instead.
 *
 * Ignored by default, opt out per handler:
 * - **⌘/Ctrl/Alt chords** (`allowChords`) — so app/browser shortcuts still win.
 *   A handler that reads a raw physical key (a keyer, a game control) passes
 *   `allowChords: true`, because dropping a chorded keydown strands it with no
 *   matching keyup.
 * - **OS auto-repeat** (`ignoreRepeat`) — a held key fires once, not once per
 *   repeat tick. A handler that tracks press/release itself passes
 *   `ignoreRepeat: false` and filters `e.repeat` on its own terms.
 * - **An open `aria-modal` dialog** (`enabledInDialog`) — the dialog owns the top
 *   surface, so a key aimed at it must not reach a handler still mounted behind
 *   it. A surface that itself lives INSIDE the dialog opts back in.
 *
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
  if (!enabledInDialog && document.querySelector('[aria-modal="true"]')) return true;
  return false;
}

/**
 * True for a backtab (Shift+Tab), the "leave this widget" gesture a
 * key-capturing widget must release to the browser (WCAG 2.1.2 keyboard trap).
 * Used as `term.attachCustomKeyEventHandler((e) => !isFocusEscapeKey(e))` for
 * the Shell xterm; plain Tab stays claimed for shell completion. Chorded
 * variants are deliberately not excluded so browser/OS shortcuts pass through.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isFocusEscapeKey(event) {
  return event?.key === 'Tab' && event?.shiftKey === true;
}

/**
 * Props for the ROOT of a surface that owns a key globally (drill, keyer, rig).
 * A button focused by a mouse click would take the key over, since
 * `shouldIgnoreGlobalKey` stands down for native button activation; suppressing
 * `mousedown` focus leaves clicks and keyboard (Tab) paths untouched. Placed on
 * the root so every current and future child control is covered.
 */
// Last control whose pointer focus was suppressed: `useFocusTrap` falls back to
// it for focus restoration (WCAG 2.4.3) since it never became `activeElement`.
// Only `isConnected` is checked; it is consulted only when nothing holds focus.
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
 * The control `noPointerFocusSurfaceProps` last kept focus off, if it is still
 * in the document. Focus restoration consults this when it finds nothing
 * focused; everything else should read `document.activeElement`.
 *
 * @returns {Element | null}
 */
export function pointerFocusSuppressedElement() {
  return pointerFocusSuppressed?.isConnected ? pointerFocusSuppressed : null;
}
