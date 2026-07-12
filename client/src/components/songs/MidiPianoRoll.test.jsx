import { render, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MidiPianoRoll from './MidiPianoRoll.jsx';

// Drives the playback rAF loop deterministically (#2490): requestAnimationFrame
// is stubbed to a manual queue so each pump() runs exactly one frame. The loop
// sets no React state — it mutates refs and paints the canvas — so assertions
// read the mocked 2d-context call counts/args.

const makeCtx = () => ({
  clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
  rect: vi.fn(), clip: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
  moveTo: vi.fn(), arcTo: vi.fn(), setTransform: vi.fn(),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', globalAlpha: 1,
});

// Long file + two-voice pitch handoff at t=5000 where the pair {60,64} → {61,63}
// keeps BOTH the set size and the midi sum constant — the case a size+sum
// repaint signature would miss.
const DATA = {
  durationSec: 10000,
  minMidi: 60,
  maxMidi: 64,
  tracks: [{ index: 0 }],
  tempos: [],
  notes: [
    { id: 'a', midi: 60, startSec: 0, durationSec: 5000, velocity: 0.8, track: 0, name: 'C4' },
    { id: 'b', midi: 64, startSec: 0, durationSec: 5000, velocity: 0.8, track: 0, name: 'E4' },
    { id: 'c', midi: 61, startSec: 5000, durationSec: 5000, velocity: 0.8, track: 0, name: 'C#4' },
    { id: 'd', midi: 63, startSec: 5000, durationSec: 5000, velocity: 0.8, track: 0, name: 'D#4' },
  ],
};

describe('<MidiPianoRoll> playback rAF loop', () => {
  let ctx;
  let rafQueue;
  const pump = () => {
    const q = rafQueue;
    rafQueue = [];
    q.forEach((cb) => cb());
  };

  beforeEach(() => {
    ctx = makeCtx();
    rafQueue = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete HTMLElement.prototype.clientWidth;
  });

  const renderRoll = (getPosition, { zoom = 1 } = {}) => render(
    <MidiPianoRoll
      data={DATA}
      chords={[]}
      showChords={false}
      zoom={zoom}
      onZoomChange={() => {}}
      height={200}
      playing
      getPosition={getPosition}
      onSeek={() => {}}
      onTogglePlay={() => {}}
    />,
  );

  it('skips the full repaint on visually identical frames', () => {
    renderRoll(() => 100);
    pump(); // first loop frame paints
    const after1 = ctx.clearRect.mock.calls.length;
    pump();
    pump();
    pump();
    // Position, sounding set, and page state are all unchanged — every
    // subsequent frame skips the canvas repaint.
    expect(ctx.clearRect.mock.calls.length).toBe(after1);
  });

  it('repaints when the sounding pitches change even at constant set size, sum, and playhead pixel', () => {
    // At fit zoom, pps = (800-44)/10000 ≈ 0.0756 px/s — a 1.5 s step moves the
    // playhead well under a pixel, so only the pitch handoff distinguishes the
    // frames.
    let pos = 4999;
    renderRoll(() => pos);
    pump(); // paints with {60, 64} sounding
    const before = ctx.clearRect.mock.calls.length;
    pos = 5000.5; // same rounded playhead px; sounding set is now {61, 63}
    pump();
    expect(ctx.clearRect.mock.calls.length).toBe(before + 1);
  });

  it('pages the view to follow a playhead that exits the visible window', () => {
    // zoom 8 → view ≈ 1250 s. Jumping to t=2000 must snap the window so the
    // playhead re-enters near the left (scroll ≈ 1875 s) — verified by the
    // ruler now labeling a tick inside the new window (t=1920 → "32:00").
    let pos = 0;
    renderRoll(() => pos, { zoom: 8 });
    pump();
    pos = 2000;
    pump();
    const labels = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(labels).toContain('32:00');
  });

  it('stops chasing the playhead after an explicit wheel pan, until it re-enters the view', () => {
    let pos = 0;
    const { container } = renderRoll(() => pos, { zoom: 8 });
    const canvas = container.querySelector('canvas');
    pump();
    // User wheels the view far ahead of the playhead (deltaY pans horizontally).
    fireEvent.wheel(canvas, { deltaY: 3000 });
    pump(); // scheduleDraw repaint at the panned scroll
    pos = 2000; // playhead still far behind the panned window (scroll ≈ 4960)
    pump();
    const labels = ctx.fillText.mock.calls.map((c) => c[0]);
    // No snap back: the pre-snap window at t≈2000 would label "34:00"; a
    // followed snap would put scroll at 1875 (labels near 32:00). After the
    // pan the window sits ≈4960 s in, so the ruler labels ≈"84:00"+.
    expect(labels).toContain('84:00');
    expect(labels).not.toContain('32:00');
  });
});
