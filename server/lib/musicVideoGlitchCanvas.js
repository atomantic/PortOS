import { blockBox, edgeGlows } from './musicVideoTransitions.js';

/** Create a deterministic painter for a selected transition or in-shot effect. */
export function createMusicVideoGlitchPainter({ blockBox, edgeGlows }) {
  const scratchCanvas = (() => {
    const pool = new Map();
    return (key, width, height) => {
      let canvas = pool.get(key);
      if (!canvas) { canvas = document.createElement('canvas'); pool.set(key, canvas); }
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      return canvas;
    };
  })();

  // Deterministic tape snow: the same frame always shows the same grain.
  let snowTile = null;
  function snow() {
    if (snowTile) return snowTile;
    snowTile = document.createElement('canvas');
    snowTile.width = 256;
    snowTile.height = 256;
    const ctx = snowTile.getContext('2d');
    if (!ctx) return snowTile;
    const image = ctx.createImageData(256, 256);
    let seed = 123457;
    for (let i = 0; i < image.data.length; i += 4) {
      // xorshift32: an LCG's low byte repeats every 256 pixels and draws stripes.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const v = (seed >>> 24) & 255;
      image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v; image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return snowTile;
  }

  // The render's slip (one ffmpeg swaprect): band [y, y+h) moves `a` px over and the
  // edge it uncovers shows the strip beside it.
  function slip(ctx, src, a, y, h, width) {
    const d = Math.min(Math.abs(Math.round(a)), width - 1);
    if (d < 1 || h < 1) return;
    if (a > 0) {
      ctx.drawImage(src, 0, y, width - d, h, d, y, width - d, h);
      ctx.drawImage(src, d, y, d, h, 0, y, d, h);
    } else {
      ctx.drawImage(src, d, y, width - d, h, 0, y, width - d, h);
      ctx.drawImage(src, Math.max(0, width - 2 * d), y, d, h, width - d, y, d, h);
    }
  }

  // The render's vertical roll (one ffmpeg swaprect): the frame moves `a` px down (or up)
  // and the edge it uncovers shows the strip beside it.
  function roll(ctx, src, a, width, height) {
    const d = Math.min(Math.abs(Math.round(a)), height - 1);
    if (d < 1) return;
    if (a > 0) {
      ctx.drawImage(src, 0, 0, width, height - d, 0, d, width, height - d);
      ctx.drawImage(src, 0, d, width, d, 0, 0, width, d);
    } else {
      ctx.drawImage(src, 0, d, width, height - d, 0, 0, width, height - d);
      ctx.drawImage(src, 0, Math.max(0, height - 2 * d), width, d, 0, height - d, width, d);
    }
  }

  // The render's macroblock swap (one ffmpeg swaprect): two blocks trade places.
  function swapBlocks(ctx, src, sw, width, height) {
    const a = blockBox(sw.x1, sw.y1, sw.w, sw.h, width, height);
    const b = blockBox(sw.x2, sw.y2, sw.w, sw.h, width, height);
    const w = Math.min(a.w, b.w);
    const h = Math.min(a.h, b.h);
    if (w < 2 || h < 2) return;
    ctx.drawImage(src, a.x, a.y, w, h, b.x, b.y, w, h);
    ctx.drawImage(src, b.x, b.y, w, h, a.x, a.y, w, h);
  }

  // The render's smeared band: slipped like a tear, then blurred sideways. Squeezing the band
  // narrow and stretching it back smears it horizontally, as the render's sideways blur does.
  function smear(ctx, src, sm, width, height) {
    const y = Math.round(sm.y * height);
    const h = Math.min(Math.round(sm.h * height), height - y);
    if (h < 1) return;
    slip(ctx, src, sm.shift * width, y, h, width);
    const narrow = Math.max(1, Math.round(width / Math.max(1, (sm.blur || 0) * width * 1.5)));
    const band = scratchCanvas('smear', narrow, h);
    const bctx = band.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(ctx.canvas, 0, y, width, h, 0, 0, narrow, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(band, 0, 0, narrow, h, 0, y, width, h);
  }

  return (canvas, params, frame) => {
    const width = canvas.width;
    const height = canvas.height;
    const out = canvas.getContext('2d');
    if (!out || !width || !height) return false;
    let cur = scratchCanvas('a', width, height);
    const base = cur.getContext('2d');
    base.globalCompositeOperation = 'source-over';
    base.globalAlpha = 1;
    base.drawImage(canvas, 0, 0);
    // Slips in the render's order: the whole frame, then each torn band, ping-ponging two scratch canvases.
    const slips = [
      ...(params.roll ? [{ roll: params.roll * height }] : []),
      ...(params.shift ? [{ a: params.shift * width, y: 0, h: height }] : []),
      ...(params.tears || []).map((t) => ({ a: t.shift * width, y: Math.round(t.y * height), h: Math.round(t.h * height) })),
      ...(params.smears || []).map((sm) => ({ smear: sm })),
      ...(params.swaps || []).map((sw) => ({ swap: sw })),
    ];
    slips.forEach((s, i) => {
      const next = scratchCanvas(i % 2 ? 'a' : 'b', width, height);
      const ctx = next.getContext('2d');
      ctx.drawImage(cur, 0, 0);
      if (s.roll) roll(ctx, cur, s.roll, width, height);
      else if (s.swap) swapBlocks(ctx, cur, s.swap, width, height);
      else if (s.smear) smear(ctx, cur, s.smear, width, height);
      else slip(ctx, cur, s.a, s.y, Math.min(s.h, height - s.y), width);
      cur = next;
    });

    // Colour fringe: red and blue pulled apart sideways, rebuilt additively.
    out.globalCompositeOperation = 'source-over';
    out.globalAlpha = 1;
    const fringe = Math.round((params.chroma || 0) * width);
    if (fringe > 0) {
      out.fillStyle = '#000';
      out.fillRect(0, 0, width, height);
      [['#f00', -fringe], ['#0f0', 0], ['#00f', fringe]].forEach(([mask, dx], i) => {
        const layer = scratchCanvas(`c${i}`, width, height);
        const lctx = layer.getContext('2d');
        lctx.globalCompositeOperation = 'source-over';
        lctx.fillStyle = '#000';
        lctx.fillRect(0, 0, width, height);
        lctx.drawImage(cur, dx, 0);
        lctx.globalCompositeOperation = 'multiply';
        lctx.fillStyle = mask;
        lctx.fillRect(0, 0, width, height);
        lctx.globalCompositeOperation = 'source-over';
        out.globalCompositeOperation = 'lighter';
        out.drawImage(layer, 0, 0);
      });
      out.globalCompositeOperation = 'source-over';
    } else {
      out.drawImage(cur, 0, 0);
    }

    // Brightness and saturation, in the render's order (before the bar, lines and snow).
    const bright = params.bright ?? 1;
    const sat = params.sat ?? 1;
    if (bright > 1) {
      // Adding the picture to itself at (b - 1) scales it by b.
      const lit = scratchCanvas('lit', width, height);
      lit.getContext('2d').drawImage(canvas, 0, 0);
      out.globalCompositeOperation = 'lighter';
      out.globalAlpha = Math.min(1, bright - 1);
      out.drawImage(lit, 0, 0);
    } else if (bright < 1) {
      out.globalAlpha = 1 - bright;
      out.fillStyle = '#000';
      out.fillRect(0, 0, width, height);
    }
    if (sat < 1) {
      out.globalCompositeOperation = 'saturation';
      out.globalAlpha = 1 - sat;
      out.fillStyle = '#808080';
      out.fillRect(0, 0, width, height);
    }
    out.globalCompositeOperation = 'source-over';
    out.globalAlpha = 1;
    for (const b of params.blocks || []) {
      const box = blockBox(b.x, b.y, b.w, b.h, width, height);
      out.globalAlpha = b.alpha;
      out.fillStyle = `#${b.color}`;
      out.fillRect(box.x, box.y, box.w, box.h);
    }
    for (const glow of edgeGlows(params.glows)) {
      const reach = glow.size * (glow.side === 'left' || glow.side === 'right' ? width : height);
      const [x0, y0, x1, y1] = glow.side === 'left' ? [0, 0, reach, 0] : glow.side === 'right' ? [width, 0, width - reach, 0]
        : glow.side === 'top' ? [0, 0, 0, reach] : [0, height, 0, height - reach];
      const ramp = out.createLinearGradient(x0, y0, x1, y1);
      ramp.addColorStop(0, `#${glow.color}`);
      ramp.addColorStop(1, `#${glow.color}00`);
      out.globalAlpha = glow.alpha;
      out.fillStyle = ramp;
      out.fillRect(0, 0, width, height);
    }
    out.globalAlpha = 1;
    for (const bar of [...(params.bar ? [params.bar] : []), ...(params.bars || [])]) {
      out.fillStyle = `rgba(255,255,255,${bar.alpha})`;
      out.fillRect(0, Math.round(bar.y * height), width, Math.max(2, Math.round(bar.h * height)));
    }
    if (params.lines) {
      const gap = Math.max(2, Math.round(height / 270));
      out.fillStyle = `rgba(0,0,0,${params.lines})`;
      for (let y = 0; y < height; y += gap) out.fillRect(0, y, width, Math.max(1, Math.floor(gap / 2)));
    }
    if (params.noise) {
      const pattern = out.createPattern(snow(), 'repeat');
      if (pattern) {
        out.save();
        out.globalCompositeOperation = 'overlay';
        out.globalAlpha = Math.min(1, params.noise);
        // Each frame shifts the grain, as the render's temporal noise does.
        out.translate((frame * 97) % 256, (frame * 61) % 256);
        out.fillStyle = pattern;
        out.fillRect(-256, -256, width + 256, height + 256);
        // Past 1 the snow drowns the picture: a dead channel's static.
        if (params.noise > 1) {
          out.globalCompositeOperation = 'source-over';
          out.globalAlpha = Math.min(1, params.noise - 1);
          out.fillRect(-256, -256, width + 256, height + 256);
        }
        out.restore();
      }
    }
    if (sat > 1) {
      const saturated = scratchCanvas('saturated', width, height);
      const target = saturated.getContext('2d');
      target.filter = `saturate(${sat})`;
      target.drawImage(canvas, 0, 0);
      target.filter = 'none';
      out.drawImage(saturated, 0, 0);
    }
    return true;
  };
}

/** Inline the same painter into the sandboxed document host, without a network import. */
export function musicVideoGlitchRuntime() {
  return `globalThis.__portosMusicVideoGlitch = (${createMusicVideoGlitchPainter.toString()})({ blockBox: (() => { const even = n => Math.round(n / 2) * 2; return ${blockBox.toString()}; })(), edgeGlows: ${edgeGlows.toString()} });`;
}
