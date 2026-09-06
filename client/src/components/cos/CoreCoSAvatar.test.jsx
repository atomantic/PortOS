import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer is pinned by its own tests; here the wiring is what matters —
// which colors reach a frame, and that a state change updates the NEXT frame
// without restarting the loop.
const drawCalls = vi.hoisted(() => []);
vi.mock('../../lib/wireframeCore.js', () => ({
  drawWireframeCore: (_ctx, frame) => { drawCalls.push(frame); },
}));

import CoreCoSAvatar from './CoreCoSAvatar';
import { AGENT_STATES } from './constants';

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('CoreCoSAvatar', () => {
  let rafCallbacks;
  let reduceMotion;

  beforeEach(() => {
    drawCalls.length = 0;
    rafCallbacks = [];
    reduceMotion = false;
    // happy-dom has no 2D canvas or ResizeObserver; the frame math is mocked
    // above, so a bare context is enough for the component to size and draw.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb) => { rafCallbacks.push(cb); return rafCallbacks.length; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return reduceMotion; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    document.documentElement.style.setProperty('--port-accent-2', '255 43 214');
    document.documentElement.style.setProperty('--port-text-subtle', '107 115 144');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const tick = (ts) => act(() => {
    const pending = rafCallbacks.splice(0);
    for (const cb of pending) cb(ts);
  });

  it('draws edges in the agent-state color and rings in the theme secondary accent', () => {
    render(<CoreCoSAvatar state="coding" />);
    expect(screen.getByRole('group', { name: /Core assembly avatar/ })).toBeInTheDocument();
    tick(0);
    const frame = drawCalls.at(-1);
    expect(frame.edgeRgb).toEqual(rgbOf(AGENT_STATES.coding.color));
    expect(frame.nodeRgb).toEqual([255, 43, 214]);
    expect(frame.dimRgb).toEqual([107, 115, 144]);
  });

  it('carries a state change into the next animation frame without restarting the spin', () => {
    const { rerender } = render(<CoreCoSAvatar state="sleeping" />);
    tick(0);
    const base = drawCalls.at(-1);
    tick(100);
    const before = drawCalls.at(-1);
    expect(before.edgeRgb).toEqual(rgbOf(AGENT_STATES.sleeping.color));
    const sleepingStep = before.ay - base.ay;
    expect(sleepingStep).toBeGreaterThan(0);

    const cancelsBefore = cancelAnimationFrame.mock.calls.length;
    rerender(<CoreCoSAvatar state="ideating" speaking />);
    tick(200);
    const after = drawCalls.at(-1);
    expect(after.edgeRgb).toEqual(rgbOf(AGENT_STATES.ideating.color));
    // Ideating spins several times faster than sleeping and speaking adds a
    // burst, so the same 100ms advances the angle much further — from where it
    // already was, not from zero.
    expect(after.ay - before.ay).toBeGreaterThan(sleepingStep * 5);
    expect(after.pulse).toBeGreaterThan(before.pulse);
    expect(cancelAnimationFrame.mock.calls.length).toBe(cancelsBefore);
  });

  // The DPR hook resizes on mount BEFORE the avatar's own effect installs its
  // draw function. happy-dom's 0×0 layout skips that resize, so this stubs a
  // real box — the shipped layout gives the frame an 8rem × 5/6 tile.
  it('mounts in a sized layout, sizes the bitmap to the device pixel ratio, and paints', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240);
    vi.stubGlobal('devicePixelRatio', 2);
    expect(() => render(<CoreCoSAvatar state="planning" />)).not.toThrow();
    const canvas = screen.getByTestId('core-avatar-canvas');
    expect([canvas.width, canvas.height]).toEqual([400, 480]);
    tick(0);
    const frame = drawCalls.at(-1);
    expect([frame.width, frame.height]).toEqual([200, 240]);
  });

  it('holds a single static frame when the user prefers reduced motion', () => {
    reduceMotion = true;
    const { rerender } = render(<CoreCoSAvatar state="thinking" />);
    const initialFrames = drawCalls.length;
    tick(16);
    // The loop drew its one frame and did not schedule another.
    expect(drawCalls.length).toBe(initialFrames + 1);
    expect(rafCallbacks).toHaveLength(0);
    expect(drawCalls.at(-1).pulse).toBe(0);

    // With no loop running, a state change still repaints once in its color.
    rerender(<CoreCoSAvatar state="coding" />);
    expect(rafCallbacks).toHaveLength(0);
    expect(drawCalls.at(-1).edgeRgb).toEqual(rgbOf(AGENT_STATES.coding.color));
  });
});
