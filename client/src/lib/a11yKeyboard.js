/**
 * Keyboard-activation helpers: making a non-`<button>` element that carries an
 * `onClick` keyboard-operable, plus the shared predicates for "is this keystroke
 * an activation?" that global key handlers consult before claiming a key.
 *
 * A `<div onClick>` / `<span onClick>` is invisible to keyboard and
 * screen-reader users: it isn't focusable and Enter/Space do nothing. Native
 * `<button>` is always preferable, but when a clickable element can't be a
 * button (it wraps block content, participates in drag-and-drop, or would lose
 * its layout styling), these helpers restore the missing semantics without a
 * visual change:
 *
 *   - `role="button"` so assistive tech announces it as activatable,
 *   - `tabIndex={0}` so it enters the keyboard tab order,
 *   - an `onKeyDown` that fires the handler on Enter and Space (and
 *     `preventDefault`s Space so the page doesn't scroll).
 *
 * Usage — keep the existing `onClick` and spread the a11y props:
 *
 *   <div onClick={select} {...clickableProps(select)}>…</div>
 *
 * For a disabled clickable, pass `{ disabled: true }` — it drops `tabIndex`
 * and the key handler and sets `aria-disabled` so the element is announced as
 * unavailable but stays out of the tab order.
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
    // Only activate when the key event ORIGINATED on the element this handler
    // is attached to — not when it bubbled up from a focusable descendant.
    // A clickable container often wraps its own action buttons (a row with a
    // Delete/Stop/Remove button, an expandable card with a caret toggle);
    // without this guard, pressing Enter/Space while focused on the inner
    // button would bubble here, fire the container's handler, AND
    // `preventDefault` the button's native activation — so "Delete" would
    // select the row instead of deleting. Only focusable descendants can be a
    // distinct key-event target (a non-focusable <span>/<div> never receives
    // the keydown), so this precisely excludes the controls we must not hijack.
    // `currentTarget` is only null outside a live dispatch (synthetic test
    // events) — there the guard is a no-op and activation proceeds.
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
 * True when a keystroke is a Space press on a focused button-like element,
 * where the browser will natively activate that button.
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
  return target.closest('button, [role="button"]') != null;
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
 * The one predicate every app-global key handler consults before acting on a
 * window keystroke: "is this event off-limits to me?". `useKeyboardShortcuts`
 * (bubble-phase shortcut maps) and `useKeyCapture` (capture-phase key claiming)
 * both route through it, so a guard added here lands for both instead of having
 * to be re-remembered at each hook — the drift that let `useKeyCapture` swallow
 * native button activation while the other two Space paths stood down (#4748).
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
  // Cheapest guards first: plain flags, then a property read, then an ancestor
  // walk, and only then the full-document query — this runs on every keystroke
  // of every mounted consumer.
  if (!allowChords && (event.metaKey || event.ctrlKey || event.altKey)) return true;
  if (ignoreRepeat && event.repeat) return true;
  if (isEditableTarget(event.target)) return true;
  if (isButtonActivation(event)) return true;
  if (!enabledInDialog && document.querySelector('[aria-modal="true"]')) return true;
  return false;
}

/**
 * True when a keystroke is the focus-escape gesture — a backtab (Shift+Tab),
 * the conventional "leave this widget" move — that a key-capturing widget must
 * release to the browser instead of consuming.
 *
 * The consumer is a widget whose input surface claims nearly every keystroke —
 * the Shell page's xterm terminal, whose helper textarea sits in the tab order
 * but whose `_keyDown` `preventDefault`s Tab, Shift+Tab and Escape alike
 * (WCAG 2.1.2 keyboard trap). Installed as
 * `term.attachCustomKeyEventHandler((e) => !isFocusEscapeKey(e))`, the `false`
 * return makes xterm bail before it cancels the event, so the browser performs
 * the backtab and focus lands on the previous tabbable element — and nothing
 * is sent to the PTY. Plain Tab stays claimed: it is shell completion, and
 * forward-leaving is what the controls laid out before the terminal are for.
 *
 * Chorded variants are deliberately not excluded — a Ctrl/Alt+Shift+Tab the
 * browser or OS owns (previous browser tab, window switching) must pass
 * through rather than be eaten by the widget too.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export function isFocusEscapeKey(event) {
  return event?.key === 'Tab' && event?.shiftKey === true;
}

/**
 * Props for the ROOT of a surface that owns a key globally — a drill scored on
 * Space, the Morse keyer, RapidReader, the OpenWorld rig.
 *
 * On such a surface a button that keeps focus after a mouse click silently takes
 * the key over: `shouldIgnoreGlobalKey` correctly stands the global handler down
 * for native button activation, so the next Space presses the lingering button
 * instead of driving the surface. `preventDefault` on `mousedown` is what
 * suppresses that focus — it leaves the click itself, and every keyboard path,
 * untouched, so a user who TABS to the button still focuses and activates it.
 *
 * This sits on the surface root rather than on each button deliberately. The
 * per-button form has to be remembered for every control on the surface and for
 * every control added later — the same "re-remember it at each site" drift that
 * made #4748 a bug in the first place — and these surfaces render their buttons
 * across several child components. One capture-phase handler at the root covers
 * all of them, including ones that don't exist yet.
 */
// The control whose pointer focus was last suppressed. A button that opens a
// dialog never becomes `document.activeElement`, so `useFocusTrap` would capture
// `<body>` as the element to restore focus to on close (WCAG 2.4.3) — this is
// what it falls back to instead. No staleness guard is needed beyond
// `isConnected`: the fallback is only ever consulted when nothing else holds
// focus, and anything else taking focus is exactly what makes that untrue.
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
