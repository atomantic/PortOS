import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The trim endpoint is the whole point of Save — mock it so the test asserts
// the exact payload the UI sends without hitting the network. Canvas painting
// is a no-op in jsdom (getContext returns null) and the component guards it, so
// the frame math (toggle / enable-all / invert / save gating) is what's covered.
vi.mock('../../services/apiSprites.js', () => ({
  trimSpriteWalk: vi.fn(() => Promise.resolve({
    strip: 'walk/trims/east-loop-v001-strip.png',
    loop: 'walk/trims/east-loop-v001.gif',
    manifest: 'walk/trims/east-loop-v001.json',
    frameCount: 7,
    disabledFrameCount: 1,
  })),
}));

import LoopTrimmer from './LoopTrimmer';
import { trimSpriteWalk } from '../../services/apiSprites.js';

// jsdom has no 2D canvas; the component already guards a null context. Stub
// getContext to return null explicitly so the suite doesn't spam jsdom's
// "Not implemented: getContext" warning for every frame canvas it renders.
// The paint test below swaps in a recording context so the actual draw calls
// can be asserted, then restores this default.
const nullContext = () => null;
HTMLCanvasElement.prototype.getContext = nullContext;

// Records every 2D call a frame canvas makes, so the paint path (which is
// otherwise invisible under the null-context stub) can be pinned.
function recordingContext() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
  };
  HTMLCanvasElement.prototype.getContext = () => ctx;
  return { calls, ctx, restore: () => { HTMLCanvasElement.prototype.getContext = nullContext; } };
}

// jsdom never fetches, so a real `new Image()` would never fire onload and the
// trimmer's cell geometry would stay 0×0 — the frame canvases would never
// mount. This fake reports a known natural size (8 cells of 384², the native
// walk strip) and fires onload on the next tick, which is what lets the
// source-resolution assertions below see real dimensions.
const STRIP_CELL_PX = 384;
const STRIP_FRAMES = 8;
class FakeImage {
  constructor() {
    this.naturalWidth = STRIP_CELL_PX * STRIP_FRAMES;
    this.naturalHeight = STRIP_CELL_PX;
    this.onload = null;
  }

  set src(value) {
    this._src = value;
    // Async, like a real decode — so a test can also observe the pre-load state.
    setTimeout(() => { if (this.onload) this.onload(); }, 0);
  }

  get src() { return this._src; }
}
global.Image = FakeImage;

const grokRun = {
  id: 'walk-east-1', direction: 'east', status: 'candidate',
  stripPreview: { stripPath: 'grok/walk-east-1/generated/strip.png', frameCount: 8, fps: 12 },
};

const renderTrimmer = (props = {}) => render(
  <LoopTrimmer
    record={{ id: 'example-walker' }}
    walk={{ runs: [grokRun] }}
    assets={[]}
    onSelectRun={vi.fn()}
    onSaved={vi.fn()}
    {...props}
  />,
);

const enabledToggles = () => screen.queryAllByRole('button', { pressed: true });

describe('LoopTrimmer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeds every frame enabled and gates Save at ≥2 frames', () => {
    renderTrimmer();
    expect(enabledToggles()).toHaveLength(8);
    expect(screen.getByRole('button', { name: /Save trim \(8\/8\)/ })).not.toBeDisabled();
  });

  it('toggles a frame off and reflects the count in Save', () => {
    renderTrimmer();
    fireEvent.click(enabledToggles()[0]);
    expect(enabledToggles()).toHaveLength(7);
    expect(screen.getByRole('button', { name: /Save trim \(7\/8\)/ })).toBeTruthy();
  });

  it('Enable all and Invert rewrite the whole selection', () => {
    renderTrimmer();
    fireEvent.click(screen.getByRole('button', { name: /Invert/ }));
    expect(enabledToggles()).toHaveLength(0); // all-on inverted → all-off
    expect(screen.getByRole('button', { name: /Save trim \(0\/8\)/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Enable all/ }));
    expect(enabledToggles()).toHaveLength(8);
  });

  it('saves the enabled columns + fps through the trim endpoint', async () => {
    renderTrimmer();
    fireEvent.click(enabledToggles()[7]); // drop the last frame
    fireEvent.click(screen.getByRole('button', { name: /Save trim/ }));
    await waitFor(() => expect(trimSpriteWalk).toHaveBeenCalled());
    expect(trimSpriteWalk).toHaveBeenCalledWith(
      'example-walker',
      { runId: 'walk-east-1', enabledColumns: [0, 1, 2, 3, 4, 5, 6], fps: 12 },
      { silent: true },
    );
    // Result area surfaces the returned strip / GIF / manifest paths.
    await screen.findByText(/walk\/trims\/east-loop-v001\.json/);
  });

  it('sends a sanitized slug when the user names the output', async () => {
    renderTrimmer();
    fireEvent.change(screen.getByLabelText(/Output name/), { target: { value: 'East Loop V2!' } });
    expect(screen.getByText('east-loop-v2')).toBeTruthy(); // live slug preview
    fireEvent.click(screen.getByRole('button', { name: /Save trim/ }));
    await waitFor(() => expect(trimSpriteWalk).toHaveBeenCalled());
    expect(trimSpriteWalk.mock.calls[0][1]).toMatchObject({ slug: 'east-loop-v2' });
  });

  it('offers Save for an imported/redraw run (strip outside grok/ is trimmable now)', () => {
    renderTrimmer({
      walk: { runs: [{ ...grokRun, stripPreview: { ...grokRun.stripPreview, stripPath: 'imagegen/v19/clean-alpha.png' } }] },
    });
    expect(screen.getByRole('button', { name: /Save trim/ })).not.toBeDisabled();
  });

  it('disables Save for a read-only source (a saved trim has no run to re-trim)', () => {
    renderTrimmer({
      walk: { runs: [] },
      assets: [{ path: 'walk/trims/east-loop-v001-strip.png', width: 96 * 7, height: 96 }],
    });
    expect(screen.getByRole('button', { name: /Save trim/ })).toBeDisabled();
  });

  // #2977: the trimmer used to size each canvas at its DISPLAY size (64/192px),
  // decimating a 384px cell nearest-neighbor and then letting CSS smooth-upscale
  // the result — the "fuzzy" render. These lock in source-resolution painting.
  it('paints every frame at the source cell resolution, scaled by CSS with pixelated', async () => {
    const { container } = renderTrimmer();
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBeGreaterThan(0));
    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases).toHaveLength(STRIP_FRAMES + 1); // 8 thumbnails + the main preview
    canvases.forEach((canvas) => {
      expect(canvas.width).toBe(STRIP_CELL_PX);
      expect(canvas.height).toBe(STRIP_CELL_PX);
      expect(canvas).toHaveStyle({ imageRendering: 'pixelated' });
    });
  });

  // Moving the checkerboard onto the box left the canvas transparent, which makes
  // the clear-before-draw load-bearing: without it a frame swap composites the new
  // cell over the previous one wherever the new cell is transparent (ghosting).
  it('clears before each draw and copies the cell 1:1 with smoothing off', async () => {
    const { calls, ctx, restore } = recordingContext();
    try {
      renderTrimmer();
      // Wait until every thumbnail has painted, and pin the col → source-x
      // mapping while doing it: each of the 8 thumbnails must read its OWN cell
      // out of the strip. Asserting only that source-x lands on a cell boundary
      // would still pass if `col` were dropped and every frame showed cell 0.
      const drawnColumns = () => [
        ...new Set(calls.filter(([fn]) => fn === 'drawImage').map((c) => c[2] / STRIP_CELL_PX)),
      ].sort((a, b) => a - b);
      await waitFor(() => {
        expect(drawnColumns()).toEqual(Array.from({ length: STRIP_FRAMES }, (_, i) => i));
      });
      const drawAt = calls.map(([fn], i) => (fn === 'drawImage' ? i : -1)).filter((i) => i >= 0);
      drawAt.forEach((i) => {
        // Every draw is immediately preceded by a full-surface clear.
        expect(calls[i - 1]).toEqual(['clearRect', 0, 0, STRIP_CELL_PX, STRIP_CELL_PX]);
        // 1:1 — source rect and destination rect are both the natural cell size,
        // so drawImage never resamples. Source x lands on a cell boundary.
        const [, , sx, sy, sw, sh, dx, dy, dw, dh] = calls[i];
        expect([sy, sw, sh]).toEqual([0, STRIP_CELL_PX, STRIP_CELL_PX]);
        expect([dx, dy, dw, dh]).toEqual([0, 0, STRIP_CELL_PX, STRIP_CELL_PX]);
        expect(sx % STRIP_CELL_PX).toBe(0);
      });
      expect(ctx.imageSmoothingEnabled).toBe(false);
    } finally {
      restore();
    }
  });

  it('puts the checkerboard on the frame box, not inside the canvas', async () => {
    const { container } = renderTrimmer();
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBeGreaterThan(0));
    const canvas = container.querySelector('canvas');
    expect(canvas.getAttribute('style')).not.toMatch(/linear-gradient/);
    expect(canvas.parentElement.getAttribute('style')).toMatch(/linear-gradient/);
  });

  it('reserves each frame box at the cell aspect before and after the strip loads', async () => {
    const { container } = renderTrimmer();
    const boxes = () => [...container.querySelectorAll('[style*="linear-gradient"]')];
    // Pre-load: no canvas yet, but every box (8 thumbnails + main preview) already
    // reserves a square — it is `aspectRatio`, not the canvas, that holds the layout.
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
    expect(boxes()).toHaveLength(STRIP_FRAMES + 1);
    boxes().forEach((box) => expect(box.style.aspectRatio).toBe('1 / 1'));
    // Post-load: the reserved aspect is unchanged, so nothing reflows.
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBeGreaterThan(0));
    boxes().forEach((box) => {
      expect(box.style.aspectRatio).toBe(`${STRIP_CELL_PX} / ${STRIP_CELL_PX}`);
    });
  });

  it('shows an empty state when there is nothing to trim', () => {
    renderTrimmer({ walk: { runs: [] } });
    expect(screen.getByText(/No animation strips to trim/)).toBeTruthy();
  });
});
