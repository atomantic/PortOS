/**
 * Keyboard-activation helpers for non-`<button>` elements that carry an
 * `onClick`.
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
