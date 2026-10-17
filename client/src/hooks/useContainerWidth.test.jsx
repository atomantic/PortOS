import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import useContainerWidth from './useContainerWidth';

let observers = [];
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.el = null; this.disconnect = vi.fn(); observers.push(this); }
  observe(el) { this.el = el; }
  fire(width) { this.cb([{ contentRect: { width } }]); }
}

afterEach(() => { observers = []; vi.unstubAllGlobals(); });

function Probe() {
  const [ready, setReady] = useState(false);
  const [ref, width] = useContainerWidth();
  if (!ready) return <button type="button" onClick={() => setReady(true)}>load</button>;
  return <div ref={ref} data-testid="measured">{width}</div>;
}

describe('useContainerWidth', () => {
  // A loading skeleton renders before the measured element exists; a
  // mount-only effect never observed it and width stayed 0 forever.
  it('observes an element that attaches after the first render', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    render(<Probe />);
    expect(observers).toHaveLength(0);
    act(() => screen.getByRole('button', { name: 'load' }).click());
    const measured = screen.getByTestId('measured');
    expect(observers.at(-1).el).toBe(measured);
    act(() => observers.at(-1).fire(1234.6));
    expect(measured.textContent).toBe('1234');
  });
});
