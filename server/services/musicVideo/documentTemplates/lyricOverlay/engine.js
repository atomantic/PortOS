/* Lyric overlay — the sung words alone, on a transparent frame.
 *
 * The storyboard animatic plays its shot frames in the PortOS page and lays
 * this page over them, so the words are drawn exactly as the final render
 * draws them (the shared lyricType.js, in each shot's text zone) with nothing
 * else: no fill, grain, vignette or HUD. The palette matches the layered
 * template's defaults. Every frame is a pure function of song time t.
 */
(() => {
  'use strict';
  const MV = window.PORTOS_MV;
  if (!MV || !MV.render) throw new Error('PORTOS_MV is missing');
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  let W = MV.render.width;
  let H = MV.render.height;
  function resize(width, height) { W = width; H = height; canvas.width = W; canvas.height = H; }
  resize(W, H);
  const palette = { fill: '#eef1ea', ink: '#07090a', accent: '#ff5a1f', strike: '#ff2a2a' };
  // lyricType.js is a module, so it runs after this classic script; it publishes
  // itself on globalThis before DOMContentLoaded.
  const lyricTypeModule = () => new Promise((resolve, reject) => {
    const check = () => (globalThis.PORTOS_LYRIC_TYPE ? resolve(globalThis.PORTOS_LYRIC_TYPE)
      : reject(new Error('lyricType.js did not load beside the lyric overlay')));
    if (globalThis.PORTOS_LYRIC_TYPE || document.readyState !== 'loading') check();
    else document.addEventListener('DOMContentLoaded', check, { once: true });
  });
  const ready = (async () => {
    const { createLyricType } = await lyricTypeModule();
    const lyricType = createLyricType(MV, { palette });
    await lyricType.ready;
    return lyricType;
  })();
  globalThis.portosComposition = {
    durationSec: MV.render.durationSec,
    fps: MV.render.fps || 24,
    width: W,
    height: H,
    formats: ['1920x1080', '1080x1920', '1080x1080'],
    layout({ width, height }) { resize(width, height); },
    async seek(t) {
      const lyricType = await ready;
      ctx.clearRect(0, 0, W, H);
      lyricType.draw(ctx, t, { width: W, height: H });
      return true;
    },
  };
})();
