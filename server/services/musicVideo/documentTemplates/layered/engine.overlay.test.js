import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The layered engine is a browser template copied into each document, so the overlay
// guard is exercised by evaluating just that helper against a recording fake context.
const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const helper = engine.slice(engine.indexOf('  const FOOTAGE_WASH_ALPHA'), engine.indexOf('  function render(t, scene, source, state)'));
const W = 1920; const H = 1080;
const footageOverlayContext = new Function('W', 'H', `${helper}\nreturn footageOverlayContext;`)(W, H);

function fakeContext() {
  const calls = [];
  return {
    calls, globalAlpha: 1, fillStyle: '#000',
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

  it('passes partial fills, other methods and property writes through unchanged', () => {
    const ctx = fakeContext();
    const view = footageOverlayContext(ctx);
    view.globalAlpha = 0.6;
    view.fillStyle = '#fff';
    view.fillRect(10, 10, 200, 100);
    view.clearRect(0, 0, 50, 50);
    view.beginPath();
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.calls).toEqual([['fillRect', 200, 100, 0.6], ['clearRect', 50, 50], ['beginPath']]);
  });
});
