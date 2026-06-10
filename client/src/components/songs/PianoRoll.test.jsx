import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PianoRoll, { layerColor } from './PianoRoll.jsx';

describe('layerColor', () => {
  it('cycles through the palette and wraps at both ends', () => {
    expect(layerColor(0)).not.toBe(layerColor(1));
    expect(layerColor(8)).toBe(layerColor(0)); // palette length is 8 → wraps
    expect(layerColor(-1)).toBe(layerColor(7)); // negative wraps positively
  });
});

// jsdom has no canvas/ResizeObserver and reports 0 widths — stub the minimum the
// component needs so draw() runs and we can assert it painted.
const makeCtx = () => ({
  clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
  rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
  moveTo: vi.fn(), arcTo: vi.fn(), setTransform: vi.fn(),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', globalAlpha: 1,
});

describe('<PianoRoll>', () => {
  let ctx;
  beforeEach(() => {
    ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete HTMLElement.prototype.clientWidth;
  });

  it('paints the keyboard and falling notes for the given parts', () => {
    render(
      <PianoRoll
        parts={[{ id: 'm', label: 'Melody', color: '#3b82f6', score: 'time: 4/4\ntempo: 120\n| C4q E4q G4q |' }]}
        tempo={120}
        getPosition={() => 0}
        playing={false}
      />,
    );
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled(); // keyboard keys + background painted
    expect(ctx.fill).toHaveBeenCalled();     // a falling note bar was drawn
  });

  it('reads the live position each frame from getPosition (so the fall is audio-synced)', () => {
    const getPosition = vi.fn(() => 0);
    render(
      <PianoRoll
        parts={[{ id: 'm', label: 'Melody', color: '#22c55e', score: 'time: 4/4\ntempo: 120\n| C4q |' }]}
        tempo={120}
        getPosition={getPosition}
        playing={false}
      />,
    );
    expect(getPosition).toHaveBeenCalled();
  });

  it('starts the rAF loop while playing and cancels it on unmount', () => {
    const raf = vi.fn(() => 1); // return a handle; do not invoke the loop (no recursion)
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    const { unmount } = render(
      <PianoRoll
        parts={[{ id: 'm', label: 'Melody', color: '#3b82f6', score: 'time: 4/4\ntempo: 120\n| C4q |' }]}
        tempo={120}
        getPosition={() => 0}
        playing
      />,
    );
    expect(raf).toHaveBeenCalled();        // animation loop scheduled while playing
    unmount();
    expect(caf).toHaveBeenCalledWith(1);   // and torn down on unmount (no leak)
  });

  it('renders the default keyboard without crashing when there are no parts', () => {
    expect(() => render(
      <PianoRoll parts={[]} tempo={120} getPosition={() => 0} playing={false} />,
    )).not.toThrow();
    // Background + default 2-octave keyboard still draw.
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});
