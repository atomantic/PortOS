/**
 * Driving a real `@dnd-kit` keyboard drag under happy-dom.
 *
 * Two things stand between a test and an honest keyboard-drag assertion, and
 * both are environment artifacts rather than product behavior:
 *
 *   1. **No layout.** happy-dom returns an all-zero `getBoundingClientRect`, so
 *      every droppable measures to the same zero-area box at the origin and
 *      `closestCenter` can only ever tie. `stubSequentialLayout` stacks the
 *      elements in DOCUMENT order instead — which is the order a vertical list
 *      really paints in, and the order the keyboard coordinate getters sort
 *      their zones by. Deriving it from the document rather than from the order
 *      elements happen to be measured matters: dnd-kit measures the node being
 *      dragged first, so a measurement-order stub puts the dragged row above
 *      everything else and collision detection picks the wrong starting zone.
 *   2. **Deferred work on both sides of the key.** `KeyboardSensor.attach()`
 *      registers its document-level keydown handler inside a `setTimeout`, so
 *      an arrow key dispatched in the same macrotask as the pickup is dropped
 *      on the floor; and dnd-kit re-measures and re-resolves collisions through
 *      its own deferred work after the key, so an assertion made immediately
 *      can read a live region one tick behind. A real user never presses two
 *      keys inside one macrotask — `pressKey` yields before AND after each
 *      dispatch, which is what makes a scripted drag behave like a human one
 *      whatever else the machine is doing.
 *
 * Use with the REAL `@dnd-kit/core` (no module mock) — proving the sensor is
 * registered is exactly what these helpers exist to do.
 */

import { act, fireEvent } from '@testing-library/react';

const ROW_HEIGHT = 40;
const ROW_WIDTH = 200;

/**
 * Stack every element vertically in document order, one row apart.
 * Call from a `beforeEach`; it returns a teardown for `afterEach`.
 *
 * @param {object} [options]
 * @param {'vertical'|'horizontal'} [options.axis='vertical'] which way the
 *   elements are laid out. A horizontal surface (the video timeline's clip
 *   lane) needs this: `sortableKeyboardCoordinates` looks for the next item in
 *   the direction of the arrow key, so Left/Right find nothing at all when
 *   every rect shares a `left`.
 * @param {number} [options.height=40] per-element height
 * @param {number} [options.width=200] per-element width
 * @returns {() => void} restores the original `getBoundingClientRect`
 */
export function stubSequentialLayout({ axis = 'vertical', height = ROW_HEIGHT, width = ROW_WIDTH } = {}) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function stubbedRect() {
    const order = Math.max(Array.prototype.indexOf.call(this.ownerDocument.querySelectorAll('*'), this), 0);
    const top = axis === 'vertical' ? order * height : 0;
    const left = axis === 'vertical' ? 0 : order * width;
    return {
      x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
      toJSON: () => ({}),
    };
  };
  return () => { Element.prototype.getBoundingClientRect = original; };
}

const flushMacrotask = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * Dispatch one key on `element` (default: whatever holds focus) and let the
 * sensor's deferred listeners and state updates settle before returning.
 *
 * @param {string} code a `KeyboardEvent.code` — 'Space', 'ArrowDown', 'Escape', …
 * @param {Element} [element]
 */
export async function pressKey(code, element) {
  const key = code === 'Space' ? ' ' : code.replace(/^Key/, '');
  // Flush the macrotask KeyboardSensor.attach() defers its listener into, so
  // the key after a pickup is not swallowed…
  await flushMacrotask();
  await act(async () => {
    fireEvent.keyDown(element || document.activeElement || document.body, { key, code });
  });
  // …and again afterwards, because dnd-kit re-measures and resolves collisions
  // through its own deferred work. Without this the assertion that follows can
  // read a live region and a DOM that are one tick behind — which shows up as a
  // suite that passes alone and fails under a loaded parallel run.
  await flushMacrotask();
}

/**
 * Press one key `times` times. Useful for walking a keyboard drag to a known
 * end of its drop-zone list before asserting: which zone a drag STARTS on comes
 * out of collision detection against the synthetic layout above, which is an
 * artifact of the environment, while stepping from a clamped boundary is the
 * product behavior a test should pin.
 *
 * @param {string} code
 * @param {number} times
 */
export async function pressKeyTimes(code, times) {
  for (let i = 0; i < times; i += 1) await pressKey(code);
}

/** Current text of the DndContext live region, or '' when nothing is announced. */
export function dndAnnouncement() {
  return document.querySelector('[id^="DndLiveRegion"]')?.textContent || '';
}
