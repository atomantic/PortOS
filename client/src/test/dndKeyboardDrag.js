// Drive keyboard drags with a deterministic layout in happy-dom.

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

export function pressKey(code, element) {
  const key = code === 'Space' ? ' ' : code.replace(/^Key/, '');
  return act(async () => { fireEvent.keyDown(element || document.activeElement || document.body, { key, code }); });
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
  return document.querySelector('[data-dnd-announcement]')?.textContent || '';
}
