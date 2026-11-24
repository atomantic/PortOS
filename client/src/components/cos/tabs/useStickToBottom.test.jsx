import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import useStickToBottom from './useStickToBottom.js';

// A fake scroll container: `scrollHeight` is set by the test, `scrollTop` is
// whatever the hook (or a simulated user) last wrote, and the registered
// scroll listener is invoked by hand.
const makeContainer = (scrollHeight) => {
  const listeners = new Set();
  const el = {
    scrollTop: 0,
    scrollHeight,
    clientHeight: 200,
    addEventListener: (type, fn) => { if (type === 'scroll') listeners.add(fn); },
    removeEventListener: (_type, fn) => { listeners.delete(fn); },
  };
  const userScrollTo = (top) => {
    el.scrollTop = top;
    for (const fn of listeners) fn();
  };
  return { el, listeners, userScrollTo };
};

describe('useStickToBottom', () => {
  it('follows appended content until the user scrolls up, and re-pins at the bottom', () => {
    const { el, userScrollTo } = makeContainer(1000);
    const ref = { current: el };
    const { rerender } = renderHook(({ revision }) => useStickToBottom(ref, { revision }), {
      initialProps: { revision: 0 },
    });
    expect(el.scrollTop).toBe(1000);

    el.scrollHeight = 1500;
    rerender({ revision: 1 });
    expect(el.scrollTop).toBe(1500);

    // The reader scrolls back to inspect something: new content must not yank
    // them down.
    userScrollTo(200);
    el.scrollHeight = 2000;
    rerender({ revision: 2 });
    expect(el.scrollTop).toBe(200);

    // Back within the slack of the bottom: pinned again.
    userScrollTo(2000 - 200 - 10);
    el.scrollHeight = 2500;
    rerender({ revision: 3 });
    expect(el.scrollTop).toBe(2500);
  });

  it('attaches nothing and leaves the scroll position alone while disabled', () => {
    const { el, listeners } = makeContainer(1000);
    el.scrollTop = 120;
    const ref = { current: el };
    const { rerender } = renderHook(
      ({ enabled, revision }) => useStickToBottom(ref, { enabled, revision }),
      { initialProps: { enabled: false, revision: 0 } },
    );
    expect(listeners.size).toBe(0);
    expect(el.scrollTop).toBe(120);

    // Enabling opens at the tail regardless of where the user had left it.
    rerender({ enabled: true, revision: 0 });
    expect(listeners.size).toBe(1);
    expect(el.scrollTop).toBe(1000);

    rerender({ enabled: false, revision: 1 });
    expect(listeners.size).toBe(0);
  });
});
