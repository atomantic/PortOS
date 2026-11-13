// The camera stand: cached painted layers, scratch canvases, and the optical finish every frame gets.
import { hash, rng } from './core.js';

export function makeStage(W, H) {
  const cache = new Map();
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  let grain = null;
  return {
    W, H,
    /** A layer painted once and kept (painted backgrounds). */
    cached(key, w, h, paint) {
      let c = cache.get(key);
      if (!c) { c = make(w, h); paint(c.getContext('2d'), w, h); cache.set(key, c); }
      return c;
    },
    /** A reusable canvas, cleared. */
    scratch(key, w = W, h = H) {
      let c = cache.get(`scratch:${key}`);
      if (!c) { c = make(w, h); cache.set(`scratch:${key}`, c); }
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
      g.shadowBlur = 0; g.shadowColor = 'transparent';
      g.clearRect(0, 0, w, h);
      return c;
    },
    /** Tile a cached painting on one plane. cameraX is in pixels at parallax=1. */
    layer(g, image, { cameraX = 0, parallax = 1, blur = 0, y = 0, alpha = 1 } = {}) {
      g.save();
      g.globalAlpha = alpha;
      g.filter = blur ? `blur(${blur}px)` : 'none';
      const offset = ((cameraX * parallax) % image.width + image.width) % image.width;
      // A tile beyond either edge gives the blur real pixels rather than transparent seams.
      for (let x = -offset - image.width; x < W + image.width; x += image.width) g.drawImage(image, x, y);
      g.restore();
    },
    grainTile() {
      if (!grain) {
        grain = make(512, 512);
        const g = grain.getContext('2d');
        const img = g.createImageData(512, 512);
        const r = rng(9173);
        for (let i = 0; i < img.data.length; i += 4) {
          // Slightly clumped monochrome grain around mid grey.
          const v = 128 + (r() + r() + r() - 1.5) * 74;
          img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
      }
      return grain;
    },
  };
}

/**
 * The lens and the print: soft focus, bloom with the colours pulled apart around bright things,
 * a slight misregistration of the whole frame, grain and a vignette. `scene` is the clean cel picture.
 */
export function finish(out, scene, stage, { frame = 0, bloom = 0.28, split = 0.45, bloomSplit = 2, haze = 0.06, soft = 0.25, grain = 0.045, vignette = 0.18 } = {}) {
  const { W, H } = stage;
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1; out.filter = 'none'; out.globalCompositeOperation = 'source-over';
  // 1. The plates, slightly out of register: red a touch right, blue a touch left and down.
  const base = stage.scratch('finish-base');
  const bg = base.getContext('2d');
  bg.fillStyle = '#000'; bg.fillRect(0, 0, W, H);
  const plate = stage.scratch('finish-plate');
  const pg = plate.getContext('2d');
  for (const [color, dx, dy] of [['#ff0000', split, 0], ['#00ff00', 0, 0], ['#0000ff', -split * 0.7, split * 0.45]]) {
    pg.globalCompositeOperation = 'source-over'; pg.filter = 'none'; pg.fillStyle = '#03040e'; pg.fillRect(0, 0, W, H);
    pg.filter = soft ? `blur(${soft}px)` : 'none';
    pg.drawImage(scene, 0, 0);
    pg.filter = 'none'; pg.globalCompositeOperation = 'multiply'; pg.fillStyle = color; pg.fillRect(0, 0, W, H);
    bg.globalCompositeOperation = 'lighter';
    bg.drawImage(plate, dx - 3, dy - 2, W + 6, H + 4);
  }
  out.drawImage(base, 0, 0);
  // 2. Bloom from the bright parts only, split into a warm and a cool halo.
  const bw = W / 2, bh = H / 2;
  const glow = stage.scratch('finish-glow', bw, bh);
  const gg = glow.getContext('2d');
  gg.filter = 'brightness(0.5) contrast(6) blur(10px)';
  gg.drawImage(scene, 0, 0, bw, bh);
  gg.filter = 'none';
  const tint = stage.scratch('finish-tint', bw, bh);
  const tg = tint.getContext('2d');
  out.globalCompositeOperation = 'screen';
  for (const [color, dx, alpha] of [['#ffe6be', bloomSplit, bloom], ['#b8d7cf', -bloomSplit, bloom * 0.55]]) {
    tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, bw, bh); tg.drawImage(glow, 0, 0);
    tg.globalCompositeOperation = 'multiply'; tg.fillStyle = color; tg.fillRect(0, 0, bw, bh);
    out.globalAlpha = alpha;
    out.drawImage(tint, dx - 4, -3, W + 8, H + 6);
  }
  // 3. Diffusion: the whole picture breathes a little light into itself.
  if (haze > 0) {
    out.globalAlpha = haze; out.filter = 'blur(7px)';
    out.drawImage(scene, 0, 0);
    out.filter = 'none';
  }
  // 4. Grain (new every frame) and the vignette.
  out.globalAlpha = grain; out.globalCompositeOperation = 'overlay';
  const tile = stage.grainTile();
  const ox = Math.floor(hash(frame * 3.1) * 512), oy = Math.floor(hash(frame * 7.7 + 5) * 512);
  for (let y = -oy; y < H; y += 512) for (let x = -ox; x < W; x += 512) out.drawImage(tile, x, y);
  out.globalAlpha = 1; out.globalCompositeOperation = 'source-over';
  const v = out.createRadialGradient(W / 2, H * 0.5, H * 0.35, W / 2, H * 0.5, H * 1.05);
  v.addColorStop(0, 'rgba(2,3,14,0)'); v.addColorStop(1, `rgba(2,3,14,${vignette})`);
  out.fillStyle = v; out.fillRect(0, 0, W, H);
}
