import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The layered engine is a browser template copied into each document, so the overlay
// guard is exercised by evaluating just that helper against a recording fake context.
const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const helper = engine.slice(engine.indexOf('  const FOOTAGE_WASH_ALPHA'), engine.indexOf('  function render(t, scene, source, state)'));
const W = 1920; const H = 1080;
const footageOverlayContext = new Function('W', 'H', `${helper}\nreturn footageOverlayContext;`)(W, H);

function fakeContext(transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  const calls = [];
  return {
    calls, globalAlpha: 1, fillStyle: '#000', globalCompositeOperation: 'source-over',
    getTransform() { return transform; },
    fillRect(x, y, w, h) { calls.push(['fillRect', w, h, this.globalAlpha]); },
    clearRect(x, y, w, h) { calls.push(['clearRect', w, h]); },
    beginPath() { calls.push(['beginPath']); },
  };
}

describe('layered engine footage overlay guard', () => {
  it('turns a full-canvas fill over footage into a faint wash and drops a full clear', () => {
    const ctx = fakeContext();
    const view = footageOverlayContext(ctx);
    view.fillRect(0, 0, W, H);
    view.clearRect(0, 0, W, H);
    expect(ctx.calls).toEqual([['fillRect', W, H, 0.25]]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('measures the on-canvas area: a mostly off-screen panel passes, a scaled unit fill is caught', () => {
    const ctx = fakeContext();
    footageOverlayContext(ctx).fillRect(-W * 0.8, 0, W, H);
    expect(ctx.calls).toEqual([['fillRect', W, H, 1]]);
    const scaled = fakeContext({ a: W, b: 0, c: 0, d: H, e: 0, f: 0 });
    footageOverlayContext(scaled).fillRect(0, 0, 1, 1);
    expect(scaled.calls).toEqual([['fillRect', 1, 1, 0.25]]);
  });

  it('refuses the copy composite mode and passes everything else through', () => {
    const ctx = fakeContext();
    const view = footageOverlayContext(ctx);
    view.globalCompositeOperation = 'copy';
    expect(ctx.globalCompositeOperation).toBe('source-over');
    view.globalCompositeOperation = 'screen';
    view.globalAlpha = 0.6;
    view.fillStyle = '#fff';
    view.fillRect(10, 10, 200, 100);
    view.clearRect(0, 0, 50, 50);
    view.beginPath();
    expect(ctx.globalCompositeOperation).toBe('screen');
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.calls).toEqual([['fillRect', 200, 100, 0.6], ['clearRect', 50, 50], ['beginPath']]);
  });
});
