import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import useSidebarResize from './useSidebarResize';

const KEY = 'test-sidebar-width';

function Harness() {
  const { containerRef, width, onKeyDown } = useSidebarResize({
    storageKey: KEY, defaultWidth: 300, minWidth: 200, maxFraction: 0.5,
  });
  return (
    <div ref={containerRef}>
      <div role="separator" tabIndex={0} aria-valuenow={Math.round(width)} onKeyDown={onKeyDown} />
    </div>
  );
}

const sep = () => screen.getByRole('separator');
const now = () => Number(sep().getAttribute('aria-valuenow'));

describe('useSidebarResize keyboard operation', () => {
  beforeEach(() => {
    localStorage.clear();
    // happy-dom reports a zero rect; give the container a real width so max = 0.5 * 1000.
    Element.prototype.getBoundingClientRect = () => ({ width: 1000, height: 0, top: 0, left: 0, right: 1000, bottom: 0 });
  });

  it('widens on ArrowLeft, narrows on ArrowRight, with Shift stepping 64px, and persists', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    expect(now()).toBe(324);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(388);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(now()).toBe(364);
    fireEvent.keyDown(sep(), { key: 'ArrowRight', shiftKey: true });
    expect(now()).toBe(300);
    expect(localStorage.getItem(KEY)).toBe('300');
  });

  it('clamps to min/max and supports Home/End', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'End' });
    expect(now()).toBe(500);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(500);
    fireEvent.keyDown(sep(), { key: 'Home' });
    expect(now()).toBe(200);
    fireEvent.keyDown(sep(), { key: 'ArrowRight', shiftKey: true });
    expect(now()).toBe(200);
  });

  it('resets to the default width on Enter and Space and ignores other keys', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'End' });
    fireEvent.keyDown(sep(), { key: 'Enter' });
    expect(now()).toBe(300);
    fireEvent.keyDown(sep(), { key: 'Home' });
    fireEvent.keyDown(sep(), { key: ' ' });
    expect(now()).toBe(300);
    const notPrevented = fireEvent.keyDown(sep(), { key: 'a' });
    expect(notPrevented).toBe(true);
  });
});
