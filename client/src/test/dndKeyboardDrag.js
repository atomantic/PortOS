/**
 * Driving a real `@dnd-kit` keyboard drag under happy-dom. Two environment artifacts stand between a test and an honest assertion:
 *
 *   1. **No layout.** happy-dom's `getBoundingClientRect` is all zeros, so `closestCenter` only ties. `stubSequentialLayout` stacks elements in DOCUMENT order (how a vertical list paints,
 *      and how the keyboard coordinate getters sort zones), not measurement order: dnd-kit measures the dragged node first, which would put it above everything and pick the wrong starting zone.
 *   2. **Deferred work on both sides of the key.** `KeyboardSensor.attach()` registers its keydown handler inside a `setTimeout`, so an arrow key in the same macrotask as the pickup is dropped,
 *      and dnd-kit re-resolves collisions in deferred work after the key, so an immediate assertion can read a live region one tick behind. `pressKey` yields before AND after each dispatch.
 * Use with the REAL `@dnd-kit/core` (no module mock): proving the sensor is registered is what these helpers are for.
 */

import { act, fireEvent } from '@testing-library/react';

const ROW_HEIGHT = 40;
const ROW_WIDTH = 200;

/**
 * Stack every element vertically in document order, one row apart.
 * Call from a `beforeEach`; it returns a teardown for `afterEach`.
 * @param {object} [options]
 * @param {'vertical'|'horizontal'} [options.axis='vertical'] which way the
 *   elements are laid out. A horizontal surface (the video timeline's clip lane) needs this: `sortableKeyboardCoordinates` looks for the next item in the arrow's direction, so Left/Right find nothing when every rect shares a `left`.
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
 * Dispatch one key on `element` (default: the focused one) and let the sensor's deferred listeners and state updates settle.
 * @param {string} code a `KeyboardEvent.code` — 'Space', 'ArrowDown', 'Escape', …
 * @param {Element} [element]
 */
export async function pressKey(code, element) {
  const key = code === 'Space' ? ' ' : code.replace(/^Key/, '');
  // Flush the macrotask KeyboardSensor.attach() defers its listener into, so the key after a pickup isn't swallowed…
  await flushMacrotask();
  await act(async () => {
    fireEvent.keyDown(element || document.activeElement || document.body, { key, code });
  });
  // …and again afterwards: dnd-kit re-resolves collisions in deferred work, so without this the assertion can read a live region one tick behind (passes alone, fails under parallel load).
  await flushMacrotask();
}

/**
 * Press one key `times` times, to walk a drag to a known end of its zone list: which zone a drag STARTS on comes from collision detection against the synthetic layout (an environment artifact),
 * while stepping from a clamped boundary is the product behavior to pin.
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
