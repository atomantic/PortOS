import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiPianoRoll from './MidiPianoRoll.jsx';

// jsdom has no canvas/ResizeObserver and reports 0 widths — stub the minimum the
// component needs so draw() runs and we can assert it painted. `drawImage` is
// required because the roll composites a cached offscreen "scene" bitmap onto
// the visible canvas each repaint.
const makeCtx = () => ({
  clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
  rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
  moveTo: vi.fn(), arcTo: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn(),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', globalAlpha: 1,
});

const DATA = {
  durationSec: 2,
  minMidi: 60,
  maxMidi: 64,
  notes: [
    { id: '0:0', midi: 60, startSec: 0, durationSec: 0.5, velocity: 0.8, track: 0, name: 'C4' },
    { id: '0:1', midi: 64, startSec: 0.5, durationSec: 0.5, velocity: 0.7, track: 0, name: 'E4' },
  ],
  tracks: [{ index: 0, name: null, noteCount: 2 }],
};

describe('<MidiPianoRoll>', () => {
  let ctx;
  beforeEach(() => {
    ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete HTMLElement.prototype.clientWidth;
  });

  it('paints notes into an offscreen scene and composites it onto the canvas', () => {
    render(<MidiPianoRoll data={DATA} chords={[]} showChords={false} zoom={1} onZoomChange={() => {}} height={240} />);
    expect(ctx.setTransform).toHaveBeenCalled(); // offscreen scene built with a DPR transform
    expect(ctx.fill).toHaveBeenCalled();         // note bars drawn into the scene
    expect(ctx.drawImage).toHaveBeenCalled();    // cached scene composited to the visible canvas
  });

  it('renders the chord lane labels when showChords is set', () => {
    const chords = [{ startSec: 0, endSec: 1, label: 'Cmaj', midis: [60, 64, 67] }];
    render(<MidiPianoRoll data={DATA} chords={chords} showChords zoom={1} onZoomChange={() => {}} height={240} />);
    const labels = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(labels).toContain('Cmaj');
  });

  it('renders an empty/default view-model without crashing', () => {
    const empty = { durationSec: 0, minMidi: 60, maxMidi: 71, notes: [], tracks: [] };
    expect(() => render(
      <MidiPianoRoll data={empty} chords={[]} showChords={false} zoom={1} onZoomChange={() => {}} height={240} />,
    )).not.toThrow();
    expect(ctx.drawImage).toHaveBeenCalled();
  });
});
